/**
 * Hàng đợi phụ đề không phụ thuộc DOM.
 *
 * Whisper local thường trả nhiều câu cùng lúc; trước đây câu sau đè ngay lên câu
 * trước nên người xem chỉ thấy câu cuối. Bộ lập lịch giữ từng câu đủ lâu để đọc,
 * rút ngắn thời gian hiển thị khi có câu đang chờ, và gộp câu khi hàng đợi dài
 * để không làm mất nội dung.
 */

export interface SubtitleCue {
  segmentId: string;
  text: string;
  durationMs: number;
  generation: number;
  /** Mốc video (ms) của câu gốc, chỉ dùng cho chẩn đoán độ trễ. */
  startMs?: number;
  endMs?: number;
}

export interface SubtitleSchedulerClock {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface SubtitleSchedulerOptions {
  minDisplayMs: number;
  maxDisplayMs: number;
  /** Số câu tối đa đang chờ; vượt quá thì gộp hai câu cũ nhất. */
  maxQueued: number;
}

export const DEFAULT_SUBTITLE_SCHEDULER_OPTIONS: SubtitleSchedulerOptions = {
  minDisplayMs: 1_500,
  maxDisplayMs: 10_000,
  maxQueued: 3
};

const MAX_MERGED_CHARACTERS = 320;

const defaultClock: SubtitleSchedulerClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Thời gian tối thiểu để đọc hết một câu phụ đề (ms). */
export function readingTimeMs(text: string, options: SubtitleSchedulerOptions = DEFAULT_SUBTITLE_SCHEDULER_OPTIONS): number {
  return Math.min(options.maxDisplayMs, Math.max(1_200, 700 + text.length * 45));
}

export class SubtitleCueScheduler {
  private readonly queue: SubtitleCue[] = [];
  private readonly options: SubtitleSchedulerOptions;
  private current: SubtitleCue | null = null;
  private shownAt = 0;
  private timer: unknown = null;
  private generation = 0;

  constructor(
    private readonly display: (cue: SubtitleCue | null) => void,
    private readonly clock: SubtitleSchedulerClock = defaultClock,
    options: Partial<SubtitleSchedulerOptions> = {}
  ) {
    this.options = { ...DEFAULT_SUBTITLE_SCHEDULER_OPTIONS, ...options };
  }

  getCurrent(): SubtitleCue | null {
    return this.current;
  }

  getQueuedCount(): number {
    return this.queue.length;
  }

  /** Trả về false nếu câu thuộc generation cũ (trước khi tua) và bị bỏ qua. */
  push(cue: SubtitleCue): boolean {
    if (!cue.text.trim() || cue.generation < this.generation) return false;
    if (cue.generation > this.generation) {
      // Sau khi tua, câu của vị trí cũ không còn đúng ngữ cảnh.
      this.generation = cue.generation;
      this.queue.length = 0;
      this.stopTimer();
      this.current = null;
    }
    this.queue.push({ ...cue, text: cue.text.trim() });
    while (this.queue.length > this.options.maxQueued) this.mergeOldest();

    if (!this.current) {
      this.showNext();
      return true;
    }
    // Có câu chờ: chỉ giữ câu hiện tại tới khi đọc xong rồi chuyển.
    const remaining = readingTimeMs(this.current.text, this.options) - (this.clock.now() - this.shownAt);
    this.schedule(Math.max(0, remaining), () => this.showNext());
    return true;
  }

  /**
   * Hiển thị ngay, thay câu đang hiện và bỏ các câu chờ (đã cũ hơn). Dùng cho phụ đề đồng bộ với giọng
   * đọc: thời điểm hiển thị đã được quyết định bởi lúc giọng đọc bắt đầu, không xếp hàng theo thời gian đọc.
   */
  showNow(cue: SubtitleCue): boolean {
    if (!cue.text.trim() || cue.generation < this.generation) return false;
    this.generation = cue.generation;
    this.queue.length = 0;
    this.stopTimer();
    this.current = { ...cue, text: cue.text.trim() };
    this.shownAt = this.clock.now();
    this.display(this.current);
    this.schedule(Math.min(this.options.maxDisplayMs, Math.max(this.options.minDisplayMs, cue.durationMs)), () => this.showNext());
    return true;
  }

  invalidate(generation: number): void {
    if (generation < this.generation) return;
    this.generation = generation;
    this.clear();
  }

  clear(): void {
    this.queue.length = 0;
    this.stopTimer();
    if (this.current) {
      this.current = null;
      this.display(null);
    }
  }

  private mergeOldest(): void {
    const first = this.queue.shift();
    const second = this.queue.shift();
    if (!first || !second) {
      if (first) this.queue.unshift(first);
      return;
    }
    let text = `${first.text} ${second.text}`;
    // Giữ phần mới nhất nếu gộp quá dài để khung phụ đề không che hết video.
    if (text.length > MAX_MERGED_CHARACTERS) text = `…${text.slice(text.length - MAX_MERGED_CHARACTERS + 1).trimStart()}`;
    this.queue.unshift({
      segmentId: second.segmentId,
      text,
      durationMs: Math.min(this.options.maxDisplayMs, first.durationMs + second.durationMs),
      generation: second.generation
    });
  }

  private showNext(): void {
    this.stopTimer();
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.display(null);
      return;
    }
    this.current = next;
    this.shownAt = this.clock.now();
    this.display(next);
    if (this.queue.length > 0) {
      this.schedule(readingTimeMs(next.text, this.options), () => this.showNext());
      return;
    }
    const fullDuration = Math.min(
      this.options.maxDisplayMs,
      Math.max(this.options.minDisplayMs, next.durationMs, readingTimeMs(next.text, this.options))
    );
    this.schedule(fullDuration, () => this.showNext());
  }

  private schedule(delayMs: number, callback: () => void): void {
    this.stopTimer();
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      callback();
    }, delayMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
