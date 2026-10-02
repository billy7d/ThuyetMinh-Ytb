import { randomUUID } from 'node:crypto';
import { emitDiagnostic } from '@vietdub/shared';
import { LocalWorkerClientLike } from './worker-client.js';
import { STTProvider, STTResult, STTStreamCallbacks, STTStreamError, STTStreamSession } from '../stt/types.js';

export interface LocalSTTConfig {
  modelPath: string;
  sampleRate: number;
  channels: number;
  /** Lượng audio tối đa được giữ trong Node khi worker đang bận; vượt quá thì bỏ phần cũ nhất. */
  maxBufferedMs: number;
  /** Lượng audio tối đa gom vào một request (worker giới hạn 512 KB ≈ 16 s). */
  maxRequestMs: number;
  /** Khoảng cách tối thiểu giữa hai cảnh báo quá tải gửi lên pipeline. */
  overloadWarningIntervalMs: number;
}

export const DEFAULT_LOCAL_STT_CONFIG: LocalSTTConfig = {
  modelPath: '',
  sampleRate: 16_000,
  channels: 1,
  maxBufferedMs: 8_000,
  maxRequestMs: 4_000,
  overloadWarningIntervalMs: 15_000
};

// Timeline video được coi là liền mạch nếu lệch dưới ngưỡng này (Chrome chỉ cập nhật thời gian video ~5 Hz).
const TIMELINE_GAP_TOLERANCE_MS = 1_000;
// Sau từng ấy request lỗi liên tiếp, STT được coi là không dùng được và phiên phải dừng rõ ràng.
const MAX_CONSECUTIVE_FAILURES = 5;

interface LocalSTTEvent {
  kind: 'interim' | 'final';
  segmentId?: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  endedMidSpeech?: boolean;
}

interface LocalSTTResponse {
  events?: LocalSTTEvent[];
}

interface PendingAudio {
  pcm: Buffer;
  timestampMs: number;
  durationMs: number;
}

/**
 * Local STT boundary. The worker owns the model and utterance assembly; this
 * adapter never sends audio to a network. While the worker is busy, audio is
 * coalesced in a bounded buffer instead of failing the session.
 */
export class LocalStreamingSTTProvider implements STTProvider {
  readonly name = 'LocalFasterWhisperSTT';
  private readonly config: LocalSTTConfig;

  constructor(
    private readonly worker: LocalWorkerClientLike,
    config: Partial<LocalSTTConfig> = {}
  ) {
    this.config = { ...DEFAULT_LOCAL_STT_CONFIG, ...config };
    if (!this.config.modelPath.trim()) throw new Error('LOCAL_STT_MODEL_PATH is required');
    if (this.config.sampleRate !== 16_000 || this.config.channels !== 1) {
      throw new Error('Local STT requires mono 16 kHz PCM');
    }
    if (this.config.maxBufferedMs < 1_000) throw new Error('LOCAL_STT_MAX_BUFFERED_MS must be at least 1000');
    if (this.config.maxRequestMs < 250 || this.config.maxRequestMs > 15_000) {
      throw new Error('LOCAL_STT_MAX_REQUEST_MS must be between 250 and 15000');
    }
  }

  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    return new LocalSTTStreamSession(sessionId, this.config, this.worker, callbacks);
  }
}

class LocalSTTStreamSession implements STTStreamSession {
  // Mỗi stream có khóa riêng trong worker để hủy stream cũ sau khi tua không ảnh hưởng stream mới cùng phiên.
  private readonly streamKey: string;
  private readonly pending: PendingAudio[] = [];
  private pendingMs = 0;
  private droppedMs = 0;
  private lastOverloadWarningAt = Number.NEGATIVE_INFINITY;
  private lastErrorReportAt = Number.NEGATIVE_INFINITY;
  private consecutiveFailures = 0;
  private starting = false;
  private started = false;
  private startFailed = false;
  private inFlight = false;
  private endRequested = false;
  private aborted = false;
  private finished = false;

  constructor(
    sessionId: string,
    private readonly config: LocalSTTConfig,
    private readonly worker: LocalWorkerClientLike,
    private readonly callbacks: STTStreamCallbacks
  ) {
    this.streamKey = `${sessionId}:${randomUUID()}`;
    this.startWorkerStream();
  }

  private startWorkerStream(): void {
    if (this.starting || this.aborted) return;
    this.starting = true;
    this.started = false;
    this.worker.request<void>({
      op: 'start_stream',
      sessionId: this.streamKey,
      modelPath: this.config.modelPath,
      sampleRate: this.config.sampleRate,
      channels: this.config.channels
    }).then(
      () => {
        this.starting = false;
        this.started = true;
        this.pump();
      },
      error => {
        this.starting = false;
        this.startFailed = true;
        this.pending.length = 0;
        this.pendingMs = 0;
        if (!this.aborted) {
          this.callbacks.onError(new STTStreamError('STT_UNAVAILABLE', errorMessage(error), true));
        }
      }
    );
  }

  sendAudioChunk(pcmData: Buffer, timestampMs: number): void {
    if (this.aborted || this.endRequested || this.startFailed || pcmData.length === 0) return;
    if (pcmData.length % 2 !== 0) {
      this.reportError('STT_INVALID_AUDIO', new Error('Local STT audio must be 16-bit PCM with an even byte length'));
      return;
    }
    const durationMs = (pcmData.length / 2 / this.config.sampleRate) * 1000;
    this.pending.push({ pcm: pcmData, timestampMs, durationMs });
    this.pendingMs += durationMs;
    this.enforceBufferLimit();
    this.pump();
  }

  endStream(): void {
    if (this.aborted || this.endRequested) return;
    this.endRequested = true;
    this.pump();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.pending.length = 0;
    this.pendingMs = 0;
    // Lệnh cancel được worker xử lý ngay ở luồng đọc stdin; request cũ còn xếp hàng sẽ bị bỏ qua.
    void this.worker.request({ op: 'cancel', sessionId: this.streamKey }, { bypassQueueLimit: true, timeoutMs: 5_000 })
      .catch(() => {});
    void this.worker.request({
      op: 'end_stream',
      sessionId: this.streamKey,
      modelPath: this.config.modelPath,
      discard: true
    }).catch(() => {});
  }

  private enforceBufferLimit(): void {
    let dropped = 0;
    // Giữ phần audio mới nhất: phụ đề trễ quá xa không còn giá trị với người xem.
    while (this.pendingMs > this.config.maxBufferedMs && this.pending.length > 1) {
      const oldest = this.pending.shift()!;
      this.pendingMs -= oldest.durationMs;
      dropped += oldest.durationMs;
    }
    if (dropped <= 0) return;
    this.droppedMs += dropped;
    emitDiagnostic('local_stt', 'audio_dropped_backpressure', {
      droppedMs: Math.round(dropped),
      totalDroppedMs: Math.round(this.droppedMs),
      bufferedMs: Math.round(this.pendingMs)
    });
    const now = Date.now();
    if (now - this.lastOverloadWarningAt >= this.config.overloadWarningIntervalMs) {
      this.lastOverloadWarningAt = now;
      this.callbacks.onError(new STTStreamError(
        'STT_OVERLOADED',
        `Máy xử lý nhận dạng giọng nói chậm hơn thời gian thực; đã bỏ ${Math.round(dropped)} ms audio cũ.`
      ));
    }
  }

  private takeBatch(): PendingAudio | null {
    if (this.pending.length === 0) return null;
    const first = this.pending.shift()!;
    const parts = [first.pcm];
    let durationMs = first.durationMs;
    let expectedNextMs = first.timestampMs + first.durationMs;
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (durationMs + next.durationMs > this.config.maxRequestMs) break;
      // Tua/nhảy thời gian: gửi request riêng để worker đồng bộ lại mốc thời gian.
      if (Math.abs(next.timestampMs - expectedNextMs) > TIMELINE_GAP_TOLERANCE_MS) break;
      this.pending.shift();
      parts.push(next.pcm);
      durationMs += next.durationMs;
      expectedNextMs += next.durationMs;
    }
    this.pendingMs = Math.max(0, this.pendingMs - durationMs);
    return {
      pcm: parts.length === 1 ? first.pcm : Buffer.concat(parts),
      timestampMs: first.timestampMs,
      durationMs
    };
  }

  private pump(): void {
    if (this.inFlight || this.aborted || this.finished || !this.started) return;
    const batch = this.takeBatch();
    if (batch) {
      this.inFlight = true;
      this.worker.request<LocalSTTResponse>({
        op: 'audio_chunk',
        sessionId: this.streamKey,
        // Worker xác minh đường dẫn model ở mọi request, không chỉ lúc mở stream.
        modelPath: this.config.modelPath,
        pcmBase64: batch.pcm.toString('base64'),
        timestampMs: Math.max(0, Math.round(batch.timestampMs)),
        durationMs: Math.round(batch.durationMs),
        sampleRate: this.config.sampleRate,
        channels: this.config.channels
      }).then(
        response => {
          this.consecutiveFailures = 0;
          if (!this.aborted) for (const event of response.events ?? []) this.emitEvent(event);
        },
        error => {
          if (this.aborted || isAbortError(error)) return;
          // Worker vừa được khởi động lại sau sự cố thì mất trạng thái stream: mở lại stream thay vì báo lỗi mãi.
          if (/stream is not started/i.test(errorMessage(error))) {
            this.startWorkerStream();
            return;
          }
          // Một request lỗi không làm chết stream; request kế tiếp vẫn tiếp tục.
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.aborted = true;
            this.pending.length = 0;
            this.pendingMs = 0;
            this.callbacks.onError(new STTStreamError('STT_UNAVAILABLE', errorMessage(error), true));
            return;
          }
          this.reportError('STT_ERROR', error);
        }
      ).finally(() => {
        this.inFlight = false;
        this.pump();
      });
      return;
    }

    if (this.endRequested) {
      this.finished = true;
      this.worker.request<LocalSTTResponse>({
        op: 'end_stream',
        sessionId: this.streamKey,
        // Giữ cùng model đã pin trong suốt vòng đời stream.
        modelPath: this.config.modelPath
      }).then(
        response => {
          // Nhận nốt câu cuối nếu worker chỉ đủ điều kiện chốt utterance khi stream kết thúc.
          if (!this.aborted) for (const event of response.events ?? []) this.emitEvent(event);
        },
        error => {
          if (!this.aborted && !isAbortError(error)) this.reportError('STT_ERROR', error);
        }
      );
    }
  }

  private emitEvent(event: LocalSTTEvent): void {
    if (!event.text?.trim()) return;
    const result: STTResult = {
      segmentId: event.segmentId ? `${this.streamKey}:${event.segmentId}` : undefined,
      text: event.text.trim(),
      startMs: Math.max(0, Math.round(event.startMs)),
      endMs: Math.max(0, Math.round(event.endMs)),
      isFinal: event.kind === 'final',
      confidence: typeof event.confidence === 'number' ? event.confidence : 0,
      receivedAtMs: Date.now(),
      ...(event.endedMidSpeech ? { endedMidSpeech: true } : {})
    };
    if (event.kind === 'final') this.callbacks.onFinal(result);
    else this.callbacks.onInterim(result);
  }

  private reportError(code: string, error: unknown): void {
    // Giới hạn tần suất để lỗi lặp lại không làm ngập kênh WebSocket/popup.
    const now = Date.now();
    if (now - this.lastErrorReportAt < this.config.overloadWarningIntervalMs) return;
    this.lastErrorReportAt = now;
    this.callbacks.onError(new STTStreamError(code, errorMessage(error)));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
