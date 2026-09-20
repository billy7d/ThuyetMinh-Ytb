import {
  OperationMode,
  ServerMessage,
  TranscriptInterimMessage,
  TranscriptFinalMessage,
  TranslationReadyMessage,
  TTSChunkMessage,
  SubtitleEventMessage,
  LatencyMetricMessage,
  ErrorMessage,
  diagnosticSessionRef,
  emitDiagnostic
} from '@vietdub/shared';
import { STTProvider, STTResult, STTStreamSession } from '../stt/types.js';
import { TranslationEngine } from '../translation/translation-engine.js';
import { TTSProvider } from '../tts/types.js';
import { CostTracker, BudgetConfig } from '../cost/cost-tracker.js';

export interface PipelineCallbacks {
  sendMessage: (msg: ServerMessage) => void;
}

export class RealtimePipeline {
  private generation = 1;
  private segmentCounter = 0;
  private sttStreamToken = 0;
  private readonly processedFinalKeys = new Set<string>();
  private sttSession: STTStreamSession | null = null;
  private translationEngine: TranslationEngine;
  private ttsEngine: TTSProvider;
  private costTracker: CostTracker;
  private callbacks: PipelineCallbacks;
  private readonly sessionRef: string;

  private isActive: boolean = false;

  constructor(
    private readonly sessionId: string,
    mode: OperationMode,
    private readonly sttProvider: STTProvider,
    private readonly translationEngine: TranslationEngine,
    private readonly ttsEngine: TTSProvider,
    private readonly callbacks: PipelineCallbacks,
    budgetConfig: Partial<BudgetConfig> = {}
  ) {
    this.mode = mode;
    this.sttProvider = sttProvider;
    this.translationEngine = translationEngine;
    this.ttsEngine = ttsEngine;
    this.callbacks = callbacks;
    this.sessionRef = diagnosticSessionRef(sessionId);
    this.costTracker = new CostTracker(sessionId);
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    emitDiagnostic('pipeline', 'started', { sessionRef: this.sessionRef, mode: this.mode });
    this.sttSession = this.sttProvider.createStream(this.sessionId, {
      onInterim: (text, startMs, endMs) => this.handleInterimTranscript(text, startMs, endMs),
      onFinal: (text, startMs, endMs) => this.handleFinalTranscript(text, startMs, endMs),
      onError: (err) => this.handleError('STT_ERROR', err.message, false)
    });
  }

  handleAudioChunk(pcmData: Buffer, videoTimeMs: number): void {
    if (!this.isActive || !this.sttSession) return;
    try {
      const durationSec = pcmData.length / 2 / 16000;
      this.costTracker.recordAudioChunk(durationSec);
      emitDiagnostic('pipeline', 'audio_forwarded_to_stt', {
        sessionRef: this.sessionRef,
        pcmBytes: pcmData.length,
        timestampMs
      });
      this.sttSession.sendAudioChunk(pcmData, timestampMs);
    } catch (err: any) {
      this.handleError('AUDIO_CHUNK_ERROR', err.message, false);
    }
  }

  private openSttStream(): void {
    const token = ++this.sttStreamToken;
    this.sttSession = this.sttProvider.createStream(this.sessionId, {
      onInterim: result => {
        if (!this.isActive || token !== this.sttStreamToken) return;
        this.handleInterimTranscript(result);
      },
      onFinal: result => {
        if (!this.isActive || token !== this.sttStreamToken) return;
        void this.handleFinalTranscript(result, token).catch(error => {
          if (this.isActive && token === this.sttStreamToken) {
            this.handleError('PIPELINE_ERROR', error instanceof Error ? error.message : String(error), false);
          }
        });
      },
      onError: error => {
        if (!this.isActive || token !== this.sttStreamToken) return;
        this.handleError('STT_ERROR', error.message, false);
      }
    });
  }

  private handleInterimTranscript(result: STTResult): void {
    if (!result.text.trim()) return;
    const segmentId = result.segmentId || `seg_${this.segmentCounter}_interim`;
    const msg: TranscriptInterimMessage = {
      type: 'TRANSCRIPT_INTERIM',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId,
      sourceText: result.text,
      startMs: result.startMs,
      endMs: result.endMs
    };
    this.callbacks.sendMessage(msg);
  }

  private async handleFinalTranscript(result: STTResult, streamToken: number): Promise<void> {
    const sourceText = result.text.trim();
    if (!sourceText) return;
    const currentGeneration = this.generation;
    const dedupeKey = result.segmentId || `${result.startMs}:${result.endMs}:${sourceText}`;
    if (this.processedFinalKeys.has(dedupeKey)) return;
    this.processedFinalKeys.add(dedupeKey);
    if (this.processedFinalKeys.size > 500) {
      const first = this.processedFinalKeys.values().next().value as string | undefined;
      if (first) this.processedFinalKeys.delete(first);
    }

    const segmentId = `seg_${++this.segmentCounter}`;
    // STTResult does not yet carry a monotonic timestamp for the last audio
    // frame sent to the provider. Do not manufacture a latency number from
    // wall-clock values; live latency reporting must be instrumented at the
    // provider boundary before it is presented as evidence.
    const pipelineStartedAt = Date.now();
    const sttLatencyMs = 0;

    if (!this.isActive) {
      emitDiagnostic('pipeline', 'transcript_ignored_after_stop', { sessionRef: this.sessionRef, generation: currentGen });
      return;
    }

    // 1. Send final transcript
    const transFinalMsg: TranscriptFinalMessage = {
      type: 'TRANSCRIPT_FINAL',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId,
      sourceText,
      startMs: result.startMs,
      endMs: result.endMs
    };
    this.callbacks.sendMessage(transFinalMsg);
    emitDiagnostic('pipeline', 'transcript_final_emitted', {
      sessionRef: this.sessionRef,
      segmentId,
      generation: currentGen,
      startMs,
      endMs,
      sourceLength: sourceText.length
    });

    // 2. Translate with context awareness
    const transStartTime = Date.now();
    const transResult = await this.translationEngine.translate(sourceText, startMs, endMs);
    const transEndTime = Date.now();
    const translationDurationMs = transEndTime - transStartTime;

    // If buffered (incomplete thought), wait for completion
    if (transResult.buffered || !transResult.translatedText) {
      emitDiagnostic('pipeline', 'translation_buffered', {
        sessionRef: this.sessionRef,
        segmentId,
        sourceLength: sourceText.length
      });
      return;
    }

    if (!this.isActive || streamToken !== this.sttStreamToken || currentGeneration !== this.generation) return;
    if (transResult.buffered || !transResult.translatedText) return;
    this.costTracker.recordTranslation(sourceText.length);

    // If generation changed during translation (due to seek), discard
    if (currentGen !== this.generation) {
      emitDiagnostic('pipeline', 'translation_discarded_generation', {
        sessionRef: this.sessionRef,
        segmentId,
        generation: currentGen,
        currentGeneration: this.generation
      });
      return;
    }
    if (!this.isActive) {
      emitDiagnostic('pipeline', 'translation_discarded_after_stop', { sessionRef: this.sessionRef, segmentId });
      return;
    }

    // 3. Send translation ready
    const transReadyMsg: TranslationReadyMessage = {
      type: 'TRANSLATION_READY',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId,
      sourceText,
      translatedText: transResult.translatedText,
      startMs: result.startMs,
      endMs: result.endMs,
      generation: currentGeneration
    };
    this.callbacks.sendMessage(transReadyMsg);
    emitDiagnostic('pipeline', 'translation_ready_emitted', {
      sessionRef: this.sessionRef,
      segmentId,
      generation: currentGen,
      translatedLength: transResult.translatedText.length
    });

    if (this.mode === 'subtitle_only' || this.mode === 'dubbing_and_subtitle') {
      const subtitle: SubtitleEventMessage = {
        type: 'SUBTITLE_EVENT',
        sessionId: this.sessionId,
        timestamp: Date.now(),
        segmentId,
        text: transResult.translatedText,
        startMs: result.startMs,
        endMs: result.endMs,
        generation: currentGeneration,
        action: 'show'
      };
      this.callbacks.sendMessage(subMsg);
      emitDiagnostic('pipeline', 'subtitle_event_emitted', {
        sessionRef: this.sessionRef,
        segmentId,
        generation: currentGen,
        textLength: transResult.translatedText.length,
        startMs,
        endMs
      });
    }

    let ttsLatencyMs = 0;
    if (this.mode === 'dubbing_only' || this.mode === 'dubbing_and_subtitle') {
      const ttsStartTime = Date.now();
      const ttsRes = await this.ttsEngine.synthesize({
        sessionId: this.sessionId,
        segmentId,
        text: transResult.translatedText,
        generation: currentGeneration,
        startMs: result.startMs,
        endMs: result.endMs
      });
      ttsLatencyMs = Date.now() - ttsStartedAt;

      if (!this.isActive || streamToken !== this.sttStreamToken || currentGeneration !== this.generation) return;
      if (!ttsResult.cancelled && ttsResult.audioBase64) {
        this.costTracker.recordTTS(transResult.translatedText.length);
        const ttsMsg: TTSChunkMessage = {
          type: 'TTS_CHUNK',
          sessionId: this.sessionId,
          timestamp: Date.now(),
          segmentId,
          audioBase64: ttsResult.audioBase64,
          mimeType: ttsResult.mimeType,
          sampleRate: ttsResult.sampleRate,
          channels: ttsResult.channels,
          durationMs: ttsResult.durationMs,
          generation: currentGeneration,
          translatedText: transResult.translatedText,
          startMs: result.startMs,
          endMs: result.endMs
        };
        this.callbacks.sendMessage(ttsMsg);
        emitDiagnostic('pipeline', 'tts_chunk_emitted', {
          sessionRef: this.sessionRef,
          segmentId,
          generation: currentGen,
          audioBytesApprox: Math.floor((ttsRes.audioBase64.length * 3) / 4),
          durationMs: ttsRes.durationMs,
          textLength: transResult.translatedText.length
        });
      } else {
        emitDiagnostic('pipeline', 'tts_chunk_suppressed', {
          sessionRef: this.sessionRef,
          segmentId,
          generation: currentGen,
          cancelled: ttsRes.cancelled,
          hasAudio: Boolean(ttsRes.audioBase64)
        });
      }
    }

    // 6. Record and send latency breakdown
    const totalPipelineMs = Date.now() - sttEndTime;
    const latencyMsg: LatencyMetricMessage = {
      type: 'LATENCY_METRIC',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId,
      sttMs: sttLatencyMs,
      translationMs: translationDurationMs,
      ttsMs: ttsLatencyMs,
      totalPipelineMs: Date.now() - pipelineStartedAt
    };
    this.callbacks.sendMessage(latency);
  }

  handleSeek(_fromMs: number, _toMs: number): void {
    if (!this.isActive) return;
    const previousGeneration = this.generation;
    this.generation++;
    this.processedFinalKeys.clear();
    this.ttsEngine.cancelGeneration(previousGeneration);
    this.translationEngine.reset();
    emitDiagnostic('pipeline', 'generation_changed', {
      sessionRef: this.sessionRef,
      fromMs,
      toMs,
      generation: this.generation
    });
  }

  setMode(newMode: OperationMode): void {
    this.mode = newMode;
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  getGeneration(): number {
    return this.generation;
  }

  getProviderNames(): { stt: string; translation: string; tts: string } {
    return {
      stt: this.sttProvider.name,
      translation: this.translationEngine.getProviderName(),
      tts: this.ttsEngine.name
    };
  }

  private handleError(code: string, message: string, fatal: boolean): void {
    emitDiagnostic('pipeline', 'error', { sessionRef: this.sessionRef, code, fatal, messageLength: message.length });
    const errorMsg: ErrorMessage = {
      type: 'ERROR',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      code,
      message,
      fatal
    };
    this.callbacks.sendMessage(errorMsg);
  }

  stop(): void {
    if (!this.isActive) return;
    this.isActive = false;
    emitDiagnostic('pipeline', 'stopped', { sessionRef: this.sessionRef });
    if (this.sttSession) {
      this.sttSession.endStream();
      this.sttSession = null;
    }
  }
}
