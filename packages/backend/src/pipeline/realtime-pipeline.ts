import {
  OperationMode,
  ServerMessage,
  TranscriptInterimMessage,
  TranscriptFinalMessage,
  TranslationReadyMessage,
  TTSChunkMessage,
  SubtitleEventMessage,
  LatencyMetricMessage,
  ErrorMessage
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
    this.costTracker = new CostTracker(sessionId);
  }

  start(): void {
    this.isActive = true;
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

    // 2. Translate with context awareness
    const transStartTime = Date.now();
    const transResult = await this.translationEngine.translate(sourceText, startMs, endMs);
    const transEndTime = Date.now();
    const translationDurationMs = transEndTime - transStartTime;

    // If buffered (incomplete thought), wait for completion
    if (transResult.buffered || !transResult.translatedText) {
      return;
    }

    this.costTracker.recordTranslation(sourceText.length);

    // If generation changed during translation (due to seek), discard
    if (currentGen !== this.generation) {
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
    }

    // 5. Synthesize Vietnamese TTS if mode includes dubbing
    let ttsDurationMs = 0;
    if (this.mode === 'dubbing_only' || this.mode === 'dubbing_and_subtitle') {
      const ttsStartTime = Date.now();
      const ttsRes = await this.ttsEngine.synthesize({
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
      }
    }

    // 6. Record and send latency breakdown
    const totalPipelineMs = (Date.now() - sttEndTime) + translationDurationMs + ttsDurationMs;
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
  }

  setMode(newMode: OperationMode): void {
    this.mode = newMode;
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  private handleError(code: string, message: string, fatal: boolean): void {
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
    if (this.sttSession) {
      this.sttSession.endStream();
      this.sttSession = null;
    }
  }
}
