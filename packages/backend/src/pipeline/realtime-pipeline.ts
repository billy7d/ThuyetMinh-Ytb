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
import { STTProvider, STTStreamSession } from '../stt/types.js';
import { TranslationEngine } from '../translation/translation-engine.js';
import { TTSProvider } from '../tts/types.js';
import { CostTracker } from '../cost/cost-tracker.js';

export interface PipelineCallbacks {
  sendMessage: (msg: ServerMessage) => void;
}

export class RealtimePipeline {
  private sessionId: string;
  private mode: OperationMode;
  private generation: number = 1;
  private segmentCounter: number = 0;

  private sttProvider: STTProvider;
  private sttSession: STTStreamSession | null = null;
  private translationEngine: TranslationEngine;
  private ttsEngine: TTSProvider;
  private costTracker: CostTracker;
  private callbacks: PipelineCallbacks;
  private readonly sessionRef: string;

  private isActive: boolean = false;

  constructor(
    sessionId: string,
    mode: OperationMode,
    sttProvider: STTProvider,
    translationEngine: TranslationEngine,
    ttsEngine: TTSProvider,
    callbacks: PipelineCallbacks
  ) {
    this.sessionId = sessionId;
    this.mode = mode;
    this.sttProvider = sttProvider;
    this.translationEngine = translationEngine;
    this.ttsEngine = ttsEngine;
    this.callbacks = callbacks;
    this.sessionRef = diagnosticSessionRef(sessionId);
    this.costTracker = new CostTracker(sessionId);
  }

  start(): void {
    this.isActive = true;
    emitDiagnostic('pipeline', 'started', { sessionRef: this.sessionRef, mode: this.mode });
    this.sttSession = this.sttProvider.createStream(this.sessionId, {
      onInterim: (text, startMs, endMs) => this.handleInterimTranscript(text, startMs, endMs),
      onFinal: (text, startMs, endMs) => this.handleFinalTranscript(text, startMs, endMs),
      onError: (err) => this.handleError('STT_ERROR', err.message, false)
    });
  }

  handleAudioChunk(pcmData: Buffer, timestampMs: number): void {
    if (!this.isActive || !this.sttSession) return;

    try {
      const durationSec = (pcmData.length / 2) / 16000;
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

  private handleInterimTranscript(text: string, startMs: number, endMs: number): void {
    const segmentId = `seg_${this.segmentCounter}_interim`;
    const msg: TranscriptInterimMessage = {
      type: 'TRANSCRIPT_INTERIM',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId,
      sourceText: text,
      startMs,
      endMs
    };
    this.callbacks.sendMessage(msg);
  }

  private async handleFinalTranscript(sourceText: string, startMs: number, endMs: number): Promise<void> {
    const currentGen = this.generation;
    const segmentId = `seg_${++this.segmentCounter}`;
    const sttEndTime = Date.now();

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
      startMs,
      endMs
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
      startMs,
      endMs,
      generation: currentGen
    };
    this.callbacks.sendMessage(transReadyMsg);
    emitDiagnostic('pipeline', 'translation_ready_emitted', {
      sessionRef: this.sessionRef,
      segmentId,
      generation: currentGen,
      translatedLength: transResult.translatedText.length
    });

    // 4. Send subtitle if mode includes subtitles
    if (this.mode === 'subtitle_only' || this.mode === 'dubbing_and_subtitle') {
      const subMsg: SubtitleEventMessage = {
        type: 'SUBTITLE_EVENT',
        sessionId: this.sessionId,
        timestamp: Date.now(),
        segmentId,
        text: transResult.translatedText,
        startMs,
        endMs,
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

    // 5. Synthesize Vietnamese TTS if mode includes dubbing
    let ttsDurationMs = 0;
    if (this.mode === 'dubbing_only' || this.mode === 'dubbing_and_subtitle') {
      const ttsStartTime = Date.now();
      const ttsRes = await this.ttsEngine.synthesize({
        sessionId: this.sessionId,
        segmentId,
        text: transResult.translatedText,
        generation: currentGen,
        startMs,
        endMs
      });
      const ttsEndTime = Date.now();
      ttsDurationMs = ttsEndTime - ttsStartTime;

      if (!ttsRes.cancelled && currentGen === this.generation && ttsRes.audioBase64) {
        this.costTracker.recordTTS(transResult.translatedText.length);

        const ttsMsg: TTSChunkMessage = {
          type: 'TTS_CHUNK',
          sessionId: this.sessionId,
          timestamp: Date.now(),
          segmentId,
          audioBase64: ttsRes.audioBase64,
          durationMs: ttsRes.durationMs,
          generation: currentGen,
          translatedText: transResult.translatedText,
          startMs,
          endMs
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
      sttMs: endMs - startMs,
      translationMs: translationDurationMs,
      ttsMs: ttsDurationMs,
      totalPipelineMs
    };
    this.callbacks.sendMessage(latencyMsg);
  }

  handleSeek(fromMs: number, toMs: number): void {
    // Invalidate stale generations on seek
    this.generation++;
    this.ttsEngine.cancelGeneration(this.generation - 1);
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
    this.isActive = false;
    emitDiagnostic('pipeline', 'stopped', { sessionRef: this.sessionRef });
    if (this.sttSession) {
      this.sttSession.endStream();
      this.sttSession = null;
    }
  }
}
