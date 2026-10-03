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
import { STTProvider, STTResult, STTStreamError, STTStreamSession } from '../stt/types.js';
import { TranslationEngine } from '../translation/translation-engine.js';
import { TTSProvider } from '../tts/types.js';
import { splitForStreaming } from '../tts/split-text.js';
import { CostTracker, BudgetConfig } from '../cost/cost-tracker.js';

export interface PipelineCallbacks {
  sendMessage: (msg: ServerMessage) => void;
}

export interface PipelineTimingConfig {
  /** Bỏ câu thuyết minh nếu khi đến lượt tổng hợp, video đã chạy quá câu đó hơn ngưỡng này (ms). */
  ttsMaxLagMs: number;
  /** Số câu thuyết minh tối đa chờ tổng hợp; vượt quá thì bỏ câu cũ nhất để không trễ dồn. */
  maxPendingTts: number;
  /** Khoảng cách tối thiểu giữa hai cảnh báo không nghiêm trọng cùng mã gửi cho extension (ms). */
  warningIntervalMs: number;
  /**
   * Mảnh câu chưa trọn (không có dấu câu cuối, hoặc bị cắt giữa lúc người nói chưa ngừng) được giữ chờ phần nối tiếp;
   * nếu không có đoạn mới trong khoảng này (ms) thì dịch luôn mảnh đó để phụ đề không treo. Phải đủ dài để đoạn nối tiếp
   * (tối đa ~3.5 s âm thanh + thời gian nhận dạng) kịp tới; dịch riêng mảnh dở làm giọng đọc ngắt sai chỗ và đổi nghĩa
   * ("every | time we simplified" -> "…là" + "thời gian chúng tôi đơn giản hóa").
   */
  pendingFlushMs: number;
  /** Câu dài được tổng hợp và phát từng vế (ở dấu phẩy) để giọng đọc bắt đầu sớm hơn. */
  streamTtsParts: boolean;
  /** Câu thuyết minh ngắn hơn ngưỡng này (ký tự) đọc nguyên câu. */
  streamPartMinChars: number;
}

const DEFAULT_TIMING: PipelineTimingConfig = {
  ttsMaxLagMs: 6_000,
  maxPendingTts: 3,
  warningIntervalMs: 10_000,
  pendingFlushMs: 4_000,
  streamTtsParts: true,
  streamPartMinChars: 90
};

interface TtsJob {
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  generation: number;
  streamToken: number;
  sttLatencyMs: number;
  translationDurationMs: number;
  pipelineStartedAt: number;
  queueWaitMs: number;
  /** Phụ đề của câu này chưa gửi: sẽ gửi cùng lúc với giọng đọc (hoặc ngay khi câu bị bỏ thuyết minh). */
  subtitlePending: boolean;
}

type FinalQueueItem =
  | { kind: 'final'; result: STTResult; streamToken: number; enqueuedAtMs: number }
  | { kind: 'flush'; streamToken: number; generation: number; enqueuedAtMs: number };

interface TranslatedSegment {
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  generation: number;
  streamToken: number;
  sttLatencyMs: number;
  translationDurationMs: number;
  pipelineStartedAt: number;
  queueWaitMs: number;
}

export class RealtimePipeline {
  // Whisper cục bộ đôi khi trả nhiều câu trong một đợt; giữ bộ đệm hữu hạn đủ lớn để hấp thụ đợt trả kết quả đó.
  private static readonly MAX_PENDING_FINALS = 32;
  private generation = 1;
  private segmentCounter = 0;
  private sttStreamToken = 0;
  private readonly processedFinalKeys = new Set<string>();
  // Ghi thời điểm vào hàng đợi để tách độ trễ chờ khỏi thời gian suy luận của model.
  private readonly finalQueue: FinalQueueItem[] = [];
  private readonly ttsQueue: TtsJob[] = [];
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly audioEndWallClockByVideoMs = new Map<number, number>();
  private readonly lastWarningAtByCode = new Map<string, number>();
  private drainingFinalQueue = false;
  private activeTtsJobs = 0;
  // Nối các câu theo thứ tự hàng đợi: câu sau tổng hợp xong trước vẫn phải chờ câu trước phát đi rồi mới gửi.
  private ttsEmitChain: Promise<void> = Promise.resolve();
  private latestVideoTimeMs = 0;
  private sttSession: STTStreamSession | null = null;
  private isActive = false;
  private mode: OperationMode;
  private readonly costTracker: CostTracker;
  private readonly sessionRef: string;
  private readonly timing: PipelineTimingConfig;

  constructor(
    private readonly sessionId: string,
    mode: OperationMode,
    private readonly sttProvider: STTProvider,
    private readonly translationEngine: TranslationEngine,
    private readonly ttsEngine: TTSProvider,
    private readonly callbacks: PipelineCallbacks,
    budgetConfig: Partial<BudgetConfig> = {},
    timing: Partial<PipelineTimingConfig> = {}
  ) {
    this.mode = mode;
    this.costTracker = new CostTracker(sessionId, budgetConfig);
    this.sessionRef = diagnosticSessionRef(sessionId);
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    emitDiagnostic('pipeline', 'started', { sessionRef: this.sessionRef, mode: this.mode });
    this.openSttStream();
  }

  handleAudioChunk(pcmData: Buffer, videoTimeMs: number): void {
    if (!this.isActive || !this.sttSession) return;
    try {
      const durationSec = pcmData.length / 2 / 16000;
      this.costTracker.recordAudioChunk(durationSec);
      const audioEndVideoMs = Math.round(videoTimeMs + durationSec * 1000);
      this.latestVideoTimeMs = audioEndVideoMs;
      this.audioEndWallClockByVideoMs.set(audioEndVideoMs, Date.now());
      if (this.audioEndWallClockByVideoMs.size > 256) {
        const first = this.audioEndWallClockByVideoMs.keys().next().value as number | undefined;
        if (first !== undefined) this.audioEndWallClockByVideoMs.delete(first);
      }
      emitDiagnostic('pipeline', 'audio_forwarded_to_stt', {
        sessionRef: this.sessionRef,
        pcmBytes: pcmData.length,
        videoTimeMs
      });
      this.sttSession.sendAudioChunk(pcmData, videoTimeMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = /budget|rate limit|buffer exceeded|duration limit/i.test(message);
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
        const code = error instanceof STTStreamError ? error.code : 'STT_ERROR';
        const fatal = error instanceof STTStreamError && error.fatal;
        this.handleError(code, error.message, fatal);
        if (fatal) this.stop();
      }
    });
  }

  private closeSttStream(): void {
    const session = this.sttSession;
    this.sttSession = null;
    if (!session) return;
    // Tua/dừng: hủy ngay để worker không tiếp tục nhận dạng audio của phiên cũ.
    if (session.abort) session.abort();
    else session.endStream();
  }

  private enqueueFinalTranscript(result: STTResult, streamToken: number): void {
    const sourceText = result.text.trim();
    if (!sourceText) return;
    const dedupeKey = result.segmentId || `${result.startMs}:${result.endMs}:${sourceText}`;
    if (this.processedFinalKeys.has(dedupeKey)) return;
    if (this.finalQueue.length >= RealtimePipeline.MAX_PENDING_FINALS) {
      // Bỏ câu cũ nhất thay vì câu mới: người xem cần câu đang nói hơn câu đã trôi qua.
      this.finalQueue.shift();
      emitDiagnostic('pipeline', 'final_queue_overflow', {
        sessionRef: this.sessionRef,
        capacity: RealtimePipeline.MAX_PENDING_FINALS,
        queuedFinals: this.finalQueue.length
      });
      this.handleError(
        'PIPELINE_BACKPRESSURE',
        'Bộ xử lý đang quá tải; đã bỏ qua câu cũ nhất để bắt kịp video.',
        false
      );
    }
    // Chỉ đánh dấu sau khi đã nhận vào hàng đợi để câu bị từ chối còn có thể được gửi lại.
    this.processedFinalKeys.add(dedupeKey);
    if (this.processedFinalKeys.size > 500) {
      const first = this.processedFinalKeys.values().next().value as string | undefined;
      if (first) this.processedFinalKeys.delete(first);
    }
    // Có câu mới: mảnh câu đang giữ sẽ được ghép với câu này nên không cần flush theo thời gian.
    this.cancelPendingFlush();
    this.finalQueue.push({ kind: 'final', result, streamToken, enqueuedAtMs: Date.now() });
    void this.drainFinalQueue();
  }

  private schedulePendingFlush(streamToken: number, generation: number): void {
    this.cancelPendingFlush();
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      if (!this.isActive || streamToken !== this.sttStreamToken || generation !== this.generation) return;
      this.finalQueue.push({ kind: 'flush', streamToken, generation, enqueuedAtMs: Date.now() });
      void this.drainFinalQueue();
    }, this.timing.pendingFlushMs);
  }

  private cancelPendingFlush(): void {
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }

  private async drainFinalQueue(): Promise<void> {
    if (this.drainingFinalQueue) return;
    this.drainingFinalQueue = true;
    try {
      while (this.isActive && this.finalQueue.length > 0) {
        const item = this.finalQueue.shift();
        if (!item) continue;
        try {
          const queueWaitMs = Math.max(0, Date.now() - item.enqueuedAtMs);
          if (item.kind === 'flush') await this.handlePendingFlush(item.streamToken, item.generation, queueWaitMs);
          else await this.handleFinalTranscript(item.result, item.streamToken, queueWaitMs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/contains no speech/i.test(message)) {
            // Đoạn chỉ có nhạc/tiếng động: bỏ qua lặng lẽ, không phải lỗi để báo người dùng.
            emitDiagnostic('pipeline', 'translation_skipped_non_speech', { sessionRef: this.sessionRef });
          } else if (this.isActive && item.streamToken === this.sttStreamToken) {
            this.handleError('PIPELINE_ERROR', message, false);
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
    emitDiagnostic('pipeline', 'transcript_interim_emitted', {
      sessionRef: this.sessionRef,
      segmentId,
      sourceLength: result.text.length
    });
  }

  private async handleFinalTranscript(result: STTResult, streamToken: number, queueWaitMs: number): Promise<void> {
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
    emitDiagnostic('pipeline', 'transcript_final_emitted', {
      sessionRef: this.sessionRef,
      segmentId,
      generation: currentGeneration,
      startMs: result.startMs,
      endMs: result.endMs,
      sourceLength: sourceText.length,
      // Độ tin cậy của Whisper (exp(avg_logprob)); không chứa nội dung, dùng để đối chiếu câu nghe nhầm.
      confidence: Math.round((Number.isFinite(result.confidence) ? result.confidence : 0) * 100) / 100
    });

    const translationStartedAt = Date.now();
    const transResult = await this.translationEngine.translate(
      sourceText, result.startMs, result.endMs, result.endedMidSpeech ? { endedMidSpeech: true } : {}
    );
    const translationDurationMs = Date.now() - translationStartedAt;

    if (transResult.buffered || !transResult.translatedText) {
      emitDiagnostic('pipeline', 'translation_buffered', {
        sessionRef: this.sessionRef,
        segmentId,
        sourceLength: sourceText.length
      });
      if (this.translationEngine.hasFlushablePending() && currentGeneration === this.generation && streamToken === this.sttStreamToken) {
        this.schedulePendingFlush(streamToken, currentGeneration);
      }
      return;
    }
    this.publishTranslation({
      segmentId,
      sourceText: transResult.sourceText || sourceText,
      translatedText: transResult.translatedText,
      // Bản dịch có thể gộp nhiều câu STT; dùng mốc bắt đầu của cả đoạn đã gộp.
      startMs: Math.min(result.startMs, transResult.startMs ?? result.startMs),
      endMs: result.endMs,
      generation: currentGeneration,
      streamToken,
      sttLatencyMs,
      translationDurationMs,
      pipelineStartedAt,
      queueWaitMs
    });
  }

  /** Không có câu nối tiếp mảnh câu đang giữ: dịch luôn mảnh đó. */
  private async handlePendingFlush(streamToken: number, generation: number, queueWaitMs: number): Promise<void> {
    if (streamToken !== this.sttStreamToken || generation !== this.generation || !this.translationEngine.hasFlushablePending()) return;
    const segmentId = `seg_${++this.segmentCounter}`;
    const pipelineStartedAt = Date.now();
    const transResult = await this.translationEngine.flushPending();
    if (transResult.buffered || !transResult.translatedText) return;
    emitDiagnostic('pipeline', 'translation_pending_flushed', {
      sessionRef: this.sessionRef,
      segmentId,
      sourceLength: transResult.sourceText.length
    });
    const endMs = transResult.endMs ?? this.latestVideoTimeMs;
    this.publishTranslation({
      segmentId,
      sourceText: transResult.sourceText,
      translatedText: transResult.translatedText,
      startMs: transResult.startMs ?? endMs,
      endMs,
      generation,
      streamToken,
      sttLatencyMs: 0,
      translationDurationMs: Date.now() - pipelineStartedAt,
      pipelineStartedAt,
      queueWaitMs
    });
  }

  private publishTranslation(segment: TranslatedSegment): void {
    const { segmentId, generation } = segment;
    if (generation !== this.generation) {
      emitDiagnostic('pipeline', 'translation_discarded_generation', {
        sessionRef: this.sessionRef,
        segmentId,
        generation,
        currentGeneration: this.generation
      });
      return;
    }
    if (!this.isActive || segment.streamToken !== this.sttStreamToken) {
      emitDiagnostic('pipeline', 'translation_discarded_after_stop', {
        sessionRef: this.sessionRef,
        segmentId
      });
      return;
    }
    this.costTracker.recordTranslation(segment.sourceText.length);

    const transReadyMsg: TranslationReadyMessage = {
      type: 'TRANSLATION_READY',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId,
      sourceText: segment.sourceText,
      translatedText: segment.translatedText,
      startMs: segment.startMs,
      endMs: segment.endMs,
      generation
    };
    this.callbacks.sendMessage(transReadyMsg);
    emitDiagnostic('pipeline', 'translation_ready_emitted', {
      sessionRef: this.sessionRef,
      segmentId,
      generation,
      translatedLength: segment.translatedText.length
    });

    const dubbing = this.mode === 'dubbing_only' || this.mode === 'dubbing_and_subtitle';
    const job: TtsJob = {
      segmentId,
      text: segment.translatedText,
      startMs: segment.startMs,
      endMs: segment.endMs,
      generation,
      streamToken: segment.streamToken,
      sttLatencyMs: segment.sttLatencyMs,
      translationDurationMs: segment.translationDurationMs,
      pipelineStartedAt: segment.pipelineStartedAt,
      queueWaitMs: segment.queueWaitMs,
      // Có thuyết minh: phụ đề được gửi cùng giọng đọc để hai thứ không lệch nhau.
      subtitlePending: dubbing
    };
    if (!dubbing) {
      this.emitSubtitle(job);
      this.emitLatency(job, 0);
      return;
    }
    this.enqueueTts(job);
  }

  /** Gửi phụ đề của một câu (một lần). syncWithTts: bên phát hiển thị đúng lúc giọng đọc bắt đầu. */
  private emitSubtitle(job: TtsJob, tts?: { durationMs: number }): void {
    job.subtitlePending = false;
    if (this.mode !== 'subtitle_only' && this.mode !== 'dubbing_and_subtitle') return;
    if (!this.isJobCurrent(job)) return;
    const subtitle: SubtitleEventMessage = {
      type: 'SUBTITLE_EVENT',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId: job.segmentId,
      text: job.text,
      startMs: job.startMs,
      endMs: job.endMs,
      generation: job.generation,
      action: 'show',
      ...(tts ? { syncWithTts: true, ttsDurationMs: tts.durationMs } : {})
    };
    this.callbacks.sendMessage(subtitle);
    emitDiagnostic('pipeline', 'subtitle_event_emitted', {
      sessionRef: this.sessionRef,
      segmentId: job.segmentId,
      generation: job.generation,
      textLength: job.text.length,
      startMs: job.startMs,
      endMs: job.endMs,
      syncWithTts: Boolean(tts),
      videoLagMs: Math.max(0, this.latestVideoTimeMs - job.endMs)
    });
  }

  private enqueueTts(job: TtsJob): void {
    this.ttsQueue.push(job);
    while (this.ttsQueue.length > this.timing.maxPendingTts) {
      const dropped = this.ttsQueue.shift();
      emitDiagnostic('pipeline', 'tts_dropped_backlog', {
        sessionRef: this.sessionRef,
        segmentId: dropped?.segmentId,
        queuedTts: this.ttsQueue.length
      });
      // Bỏ giọng đọc nhưng vẫn giữ phụ đề của câu đó.
      if (dropped?.subtitlePending) this.emitSubtitle(dropped);
    }
    this.pumpTtsQueue();
  }

  /** Chạy tối đa `concurrency` câu cùng lúc (mặc định 1: tuần tự như trước). */
  private pumpTtsQueue(): void {
    const concurrency = Math.max(1, this.ttsEngine.concurrency ?? 1);
    while (this.isActive && this.activeTtsJobs < concurrency && this.ttsQueue.length > 0) {
      const job = this.ttsQueue.shift();
      if (!job) continue;
      this.activeTtsJobs++;
      void this.runTtsJob(job).finally(() => {
        this.activeTtsJobs--;
        this.pumpTtsQueue();
      });
    }
  }

  private async runTtsJob(job: TtsJob): Promise<void> {
    const previous = this.ttsEmitChain;
    let release: () => void = () => {};
    this.ttsEmitChain = new Promise<void>(resolve => { release = resolve; });
    try {
      await this.synthesizeJob(job, previous);
    } catch (error) {
      await previous;
      if (this.isActive && job.streamToken === this.sttStreamToken && job.generation === this.generation) {
        this.handleError('TTS_ERROR', error instanceof Error ? error.message : String(error), false);
      }
      // Lỗi giọng đọc không được làm mất phụ đề.
      if (job.subtitlePending) this.emitSubtitle(job);
    } finally {
      release();
    }
  }

  private async synthesizeJob(job: TtsJob, previous: Promise<void>): Promise<void> {
    if (!this.isJobCurrent(job)) return;
    if (this.mode !== 'dubbing_only' && this.mode !== 'dubbing_and_subtitle') {
      if (job.subtitlePending) this.emitSubtitle(job);
      return;
    }
    const lagMs = this.latestVideoTimeMs - job.endMs;
    if (lagMs > this.timing.ttsMaxLagMs) {
      // Câu đã trôi qua quá xa trên video; đọc lúc này chỉ làm thuyết minh lệch thêm.
      await previous;
      emitDiagnostic('pipeline', 'tts_skipped_stale', {
        sessionRef: this.sessionRef,
        segmentId: job.segmentId,
        lagMs
      });
      if (job.subtitlePending) this.emitSubtitle(job);
      this.emitLatency(job, 0);
      return;
    }

    const ttsStartedAt = Date.now();
    const parts = this.timing.streamTtsParts
      ? splitForStreaming(job.text, { minTotalChars: this.timing.streamPartMinChars })
      : [job.text];
    const totalChars = Math.max(1, parts.reduce((sum, part) => sum + part.length, 0));
    for (let index = 0; index < parts.length; index += 1) {
      const ttsResult = await this.ttsEngine.synthesize({
        segmentId: job.segmentId,
        text: parts[index],
        generation: job.generation,
        startMs: job.startMs,
        endMs: job.endMs
      });
      const isFirst = index === 0;
      const ttsLatencyMs = Date.now() - ttsStartedAt;
      // Giữ đúng thứ tự giữa các câu: câu sau (tổng hợp xong sớm hơn) chỉ gửi sau khi câu trước đã gửi hết các vế.
      if (isFirst) await previous;
      if (!this.isJobCurrent(job)) return;
      if (ttsResult.cancelled || !ttsResult.audioBase64) {
        emitDiagnostic('pipeline', 'tts_chunk_suppressed', {
          sessionRef: this.sessionRef,
          segmentId: job.segmentId,
          generation: job.generation,
          cancelled: ttsResult.cancelled,
          hasAudio: Boolean(ttsResult.audioBase64),
          part: index
        });
        if (isFirst) {
          if (job.subtitlePending && !ttsResult.cancelled) this.emitSubtitle(job);
          this.emitLatency(job, ttsLatencyMs);
        }
        return;
      }
      this.costTracker.recordTTS(parts[index].length);
      const share = parts[index].length / totalChars;
      // Ước tính thời lượng cả câu từ vế đầu (cùng tốc độ đọc) để phụ đề không biến mất giữa chừng.
      const totalDurationMs = isFirst && parts.length > 1
        ? Math.round(ttsResult.durationMs / Math.max(0.05, parts[0].length / totalChars))
        : undefined;
      const ttsMsg: TTSChunkMessage = {
        type: 'TTS_CHUNK',
        sessionId: this.sessionId,
        timestamp: Date.now(),
        segmentId: job.segmentId,
        audioBase64: ttsResult.audioBase64,
        mimeType: ttsResult.mimeType,
        sampleRate: ttsResult.sampleRate,
        channels: ttsResult.channels,
        durationMs: ttsResult.durationMs,
        generation: job.generation,
        translatedText: job.text,
        startMs: job.startMs,
        endMs: job.endMs,
        ...(parts.length > 1 ? { partIndex: index, partCount: parts.length, slotShare: share, ...(totalDurationMs ? { totalDurationMs } : {}) } : {})
      };
      // Phụ đề đi ngay trước giọng đọc cùng segmentId; bên phát hiển thị phụ đề khi giọng đọc bắt đầu.
      if (isFirst && job.subtitlePending) this.emitSubtitle(job, { durationMs: totalDurationMs ?? ttsResult.durationMs });
      this.callbacks.sendMessage(ttsMsg);
      emitDiagnostic('pipeline', 'tts_chunk_emitted', {
        sessionRef: this.sessionRef,
        segmentId: job.segmentId,
        generation: job.generation,
        audioBytesApprox: Math.floor((ttsResult.audioBase64.length * 3) / 4),
        durationMs: ttsResult.durationMs,
        textLength: parts[index].length,
        part: index,
        partCount: parts.length
      });
      // Độ trễ ghi nhận là thời điểm có tiếng đầu tiên (vế đầu), không phải lúc xong cả câu.
      if (isFirst) this.emitLatency(job, ttsLatencyMs);
    }
  }

  private isJobCurrent(job: TtsJob): boolean {
    return this.isActive && job.streamToken === this.sttStreamToken && job.generation === this.generation;
  }

  private emitLatency(job: TtsJob, ttsLatencyMs: number): void {
    const videoLagMs = Math.max(0, this.latestVideoTimeMs - job.endMs);
    const latency: LatencyMetricMessage = {
      type: 'LATENCY_METRIC',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      segmentId: job.segmentId,
      sttMs: job.sttLatencyMs,
      translationMs: job.translationDurationMs,
      ttsMs: ttsLatencyMs,
      totalPipelineMs: Date.now() - job.pipelineStartedAt,
      videoLagMs
    };
    this.callbacks.sendMessage(latency);
    emitDiagnostic('pipeline', 'latency_metric', {
      sessionRef: this.sessionRef,
      segmentId: job.segmentId,
      sttMs: job.sttLatencyMs,
      translationMs: job.translationDurationMs,
      ttsMs: ttsLatencyMs,
      totalPipelineMs: latency.totalPipelineMs,
      videoLagMs,
      queueWaitMs: job.queueWaitMs,
      queuedFinals: this.finalQueue.length,
      queuedTts: this.ttsQueue.length
    });
  }

  handleSeek(_fromMs: number, toMs: number): void {
    if (!this.isActive) return;
    const previousGeneration = this.generation;
    this.generation++;
    this.processedFinalKeys.clear();
    this.audioEndWallClockByVideoMs.clear();
    this.latestVideoTimeMs = Number.isFinite(toMs) ? Math.max(0, toMs) : 0;
    this.ttsEngine.cancelGeneration(previousGeneration);
    this.translationEngine.reset();
    this.cancelPendingFlush();
    this.sttStreamToken++;
    this.finalQueue.length = 0;
    this.ttsQueue.length = 0;
    this.closeSttStream();
    this.openSttStream();
    emitDiagnostic('pipeline', 'generation_changed', {
      sessionRef: this.sessionRef,
      generation: this.generation
    });
  }

  setMode(newMode: OperationMode): void {
    this.mode = newMode;
    if (newMode === 'subtitle_only') {
      // Câu đang chờ giọng đọc vẫn cần phụ đề.
      const pending = this.ttsQueue.splice(0);
      for (const job of pending) if (job.subtitlePending) this.emitSubtitle(job);
    }
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
    emitDiagnostic('pipeline', 'error', {
      sessionRef: this.sessionRef,
      code,
      fatal,
      messageLength: message.length
    });
    if (!fatal) {
      // Cảnh báo lặp lại cùng mã chỉ gửi định kỳ để không làm ngập WebSocket và popup.
      const now = Date.now();
      const lastAt = this.lastWarningAtByCode.get(code);
      if (lastAt !== undefined && now - lastAt < this.timing.warningIntervalMs) return;
      this.lastWarningAtByCode.set(code, now);
    }
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
    emitDiagnostic('pipeline', 'stopped', { sessionRef: this.sessionRef });
    this.generation++;
    this.sttStreamToken++;
    this.finalQueue.length = 0;
    this.ttsQueue.length = 0;
    this.ttsEngine.cancelGeneration(this.generation - 1);
    this.translationEngine.reset();
    this.cancelPendingFlush();
    this.processedFinalKeys.clear();
    this.audioEndWallClockByVideoMs.clear();
    this.closeSttStream();
  }
}
