import type { SubtitleEventMessage } from '@vietdub/shared';

/**
 * Giữ phụ đề có `syncWithTts` cho tới khi giọng đọc cùng segmentId thật sự bắt đầu phát.
 *
 * Backend gửi phụ đề ngay trước TTS_CHUNK, nhưng giọng đọc còn phải giải mã và có thể xếp hàng sau câu
 * đang đọc. Nếu hiển thị phụ đề ngay, phụ đề sẽ đi trước thuyết minh. Bộ đồng bộ hẹn giờ hiển thị đúng
 * thời điểm câu được phát; câu bị bỏ thuyết minh (hàng chờ dài, lỗi giải mã) thì hiện phụ đề ngay.
 */

export interface SyncedSubtitleRelease {
  message: SubtitleEventMessage;
  /** Thời lượng giọng đọc thực tế (đã tính tốc độ phát), hoặc undefined nếu không có giọng đọc. */
  ttsDurationMs?: number;
}

export interface TtsSubtitleSyncClock {
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** Chờ TTS_CHUNK tối đa chừng này (ms) rồi hiện phụ đề luôn, để phụ đề không bao giờ bị mất. */
export const TTS_SUBTITLE_FALLBACK_MS = 1_500;

const defaultClock: TtsSubtitleSyncClock = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

interface HeldSubtitle {
  message: SubtitleEventMessage;
  timer: unknown;
}

export class TtsSubtitleSync {
  private readonly held = new Map<string, HeldSubtitle>();
  private readonly scheduled = new Set<unknown>();

  constructor(
    private readonly release: (item: SyncedSubtitleRelease) => void,
    private readonly clock: TtsSubtitleSyncClock = defaultClock,
    private readonly fallbackMs = TTS_SUBTITLE_FALLBACK_MS
  ) {}

  /** Trả về true nếu phụ đề được giữ để chờ giọng đọc; false nếu bên gọi cần hiển thị như bình thường. */
  offer(message: SubtitleEventMessage): boolean {
    if (!message.syncWithTts || message.action !== 'show') return false;
    this.drop(message.segmentId);
    const timer = this.clock.setTimer(() => this.releaseHeld(message.segmentId), this.fallbackMs);
    this.held.set(message.segmentId, { message, timer });
    return true;
  }

  /** Giọng đọc của segmentId đã được lên lịch phát sau delayMs, kéo dài durationMs. */
  ttsScheduled(segmentId: string, delayMs: number, durationMs: number): void {
    const item = this.held.get(segmentId);
    if (!item) return;
    this.held.delete(segmentId);
    this.clock.clearTimer(item.timer);
    const show = () => this.release({ message: item.message, ttsDurationMs: durationMs });
    if (delayMs <= 15) {
      show();
      return;
    }
    const handle = this.clock.setTimer(() => {
      this.scheduled.delete(handle);
      show();
    }, delayMs);
    this.scheduled.add(handle);
  }

  /** Giọng đọc bị bỏ hoặc lỗi: hiện phụ đề ngay. */
  ttsDropped(segmentId: string): void {
    this.releaseHeld(segmentId);
  }

  heldCount(): number {
    return this.held.size + this.scheduled.size;
  }

  /** Tua/dừng/đổi phiên: phụ đề đang chờ không còn đúng vị trí video. */
  clear(): void {
    for (const item of this.held.values()) this.clock.clearTimer(item.timer);
    this.held.clear();
    for (const handle of this.scheduled) this.clock.clearTimer(handle);
    this.scheduled.clear();
  }

  private releaseHeld(segmentId: string): void {
    const item = this.held.get(segmentId);
    if (!item) return;
    this.held.delete(segmentId);
    this.clock.clearTimer(item.timer);
    this.release({ message: item.message });
  }

  private drop(segmentId: string): void {
    const item = this.held.get(segmentId);
    if (!item) return;
    this.clock.clearTimer(item.timer);
    this.held.delete(segmentId);
  }
}
