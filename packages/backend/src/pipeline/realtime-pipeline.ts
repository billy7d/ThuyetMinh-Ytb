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
import { STTProvider, STTResult, STTStreamSession } from '../stt/types.js';
import { TranslationEngine } from '../translation/translation-engine.js';
import { TTSProvider } from '../tts/types.js';
import { CostTracker, BudgetConfig } from '../cost/cost-tracker.js';

export interface PipelineCallbacks {
  sendMessage: (msg: ServerMessage) => void;
}

export class RealtimePipeline {
  private static readonly MAX_PENDING_FINALS = 8;
  private generation = 1;
  private segmentCounter = 0;
  private sttStreamToken = 0;
  private readonly processedFinalKeys = new Set<string>();
  private readonly finalQueue: Array<{ result: STTResult; streamToken: number }> = [];
  private readonly audioEndWallClockByVideoMs = new Map<number, number>();
  private drainingFinalQueue = false;
  private sttSession: STTStreamSession | null = null;
  private isActive = false;
  private mode: OperationMode;
  private readonly costTracker: CostTracker;

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
    this.costTracker = new CostTracker(sessionId, budgetConfig);
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.openSttStream();
  }

  handleAudioChunk(pcmData: Buffer, videoTimeMs: number): void {
    if (!this.isActive || !this.sttSession) return;
    try {
      const durationSec = pcmData.length / 2 / 16000;
      this.costTracker.recordAudioChunk(durationSec);
      const audioEndVideoMs = Math.round(videoTimeMs + durationSec * 1000);
      this.audioEndWallClockByVideoMs.set(audioEndVideoMs, Date.now());
      if (this.audioEndWallClockByVideoMs.size > 256) {
        const first = this.audioEndWallClockByVideoMs.keys().next().value as number | undefined;
        if (first !== undefined) this.audioEndWallClockByVideoMs.delete(first);
      }
      this.sttSession.sendAudioChunk(pcmData, videoTimeMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = /budget|rate limit|buffer exceeded/i.test(message);
      this.handleError(fatal ? 'BUDGET_OR_RATE_LIMIT' : 'AUDIO_CHUNK_ERROR', message, fatal);
      if (fatal) this.stop();
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
        this.enqueueFinalTranscript(result, token);
      },
      onError: error => {
        if (!this.isActive || token !== this.sttStreamToken) return;
        this.handleError('STT_ERROR', error.message, false);
      }
    });
  }

  private enqueueFinalTranscript(result: STTResult, streamToken: number): void {
    const sourceText = result.text.trim();
    if (!sourceText) return;
    const dedupeKey = result.segmentId || `${result.startMs}:${result.endMs}:${sourceText}`;
    if (this.processedFinalKeys.has(dedupeKey)) return;
    this.processedFinalKeys.add(dedupeKey);
    if (this.processedFinalKeys.size > 500) {
      const first = this.processedFinalKeys.values().next().value as string | undefined;
      if (first) this.processedFinalKeys.delete(first);
    }
    if (this.finalQueue.length >= RealtimePipeline.MAX_PENDING_FINALS) {
      this.handleError(
        'PIPELINE_BACKPRESSURE',
        `Bộ xử lý đang bận; đã bỏ qua câu chờ thứ ${RealtimePipeline.MAX_PENDING_FINALS + 1}.`,
        false
      );
      return;
    }
    this.finalQueue.push({ result, streamToken });
    void this.drainFinalQueue();
  }

  private async drainFinalQueue(): Promise<void> {
    if (this.drainingFinalQueue) return;
    this.drainingFinalQueue = true;
    try {
      while (this.isActive && this.finalQueue.length > 0) {
        const item = this.finalQueue.shift();
        if (!item) continue;
        try {
          await this.handleFinalTranscript(item.result, item.streamToken);
        } catch (error) {
          if (this.isActive && item.streamToken === this.sttStreamToken) {
            this.handleError('PIPELINE_ERROR', error instanceof Error ? error.message : String(error), false);
          }
        }
      }
    } finally {
      this.drainingFinalQueue = false;
      if (this.isActive && this.finalQueue.length > 0) void this.drainFinalQueue();
    }
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

    const segmentId = `seg_${++this.segmentCounter}`;
    const pipelineStartedAt = Date.now();
    const sttLatencyMs = this.estimateSttLatency(result);

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

    const translationStartedAt = Date.now();
    const transResult = await this.translationEngine.translate(sourceText, result.startMs, result.endMs);
    const translationDurationMs = Date.now() - translationStartedAt;

    if (!this.isActive || streamToken !== this.sttStreamToken || currentGeneration !== this.generation) return;
    if (transResult.buffered || !transResult.translatedText) return;
    this.costTracker.recordTranslation(sourceText.length);

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
      this.callbacks.sendMessage(subtitle);
    }

    let ttsLatencyMs = 0;
    if (this.mode === 'dubbing_only' || this.mode === 'dubbing_and_subtitle') {
      const ttsStartedAt = Date.now();
      const ttsResult = await this.ttsEngine.synthesize({
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
      }
    }

    const latency: LatencyMetricMessage = {
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
    this.audioEndWallClockByVideoMs.clear();
    this.ttsEngine.cancelGeneration(previousGeneration);
    this.translationEngine.reset();
    this.sttStreamToken++;
    this.finalQueue.length = 0;
    this.sttSession?.endStream();
    this.sttSession = null;
    this.openSttStream();
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

  private estimateSttLatency(result: STTResult): number {
    if (!result.receivedAtMs) return 0;
    const exact = this.audioEndWallClockByVideoMs.get(Math.round(result.endMs));
    if (exact !== undefined) return Math.max(0, result.receivedAtMs - exact);

    let nearestWallClock: number | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [videoEndMs, wallClockMs] of this.audioEndWallClockByVideoMs) {
      const distance = Math.abs(videoEndMs - result.endMs);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestWallClock = wallClockMs;
      }
    }
    return nearestWallClock === undefined ? 0 : Math.max(0, result.receivedAtMs - nearestWallClock);
  }

  stop(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.generation++;
    this.sttStreamToken++;
    this.finalQueue.length = 0;
    this.ttsEngine.cancelGeneration(this.generation - 1);
    this.translationEngine.reset();
    this.processedFinalKeys.clear();
    this.audioEndWallClockByVideoMs.clear();
    this.sttSession?.endStream();
    this.sttSession = null;
  }
}
