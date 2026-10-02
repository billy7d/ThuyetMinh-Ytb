import { emitDiagnostic } from '@vietdub/shared';
import { SubtitleCue, SubtitleCueScheduler } from './subtitle-scheduler.js';

export const MIN_SUBTITLE_DISPLAY_DURATION_MS = 1500;
/** Phụ đề đồng bộ giữ thêm chừng này sau khi giọng đọc kết thúc (ms). */
export const SYNCED_SUBTITLE_TAIL_MS = 400;

export function resolveSubtitleDisplayDurationMs(
  startMs: number,
  endMs: number,
  fallbackMs = 4000
): number {
  const segmentDurationMs = endMs - startMs;
  const durationMs = Number.isFinite(segmentDurationMs) && segmentDurationMs > 0
    ? segmentDurationMs
    : fallbackMs;
  return Math.max(MIN_SUBTITLE_DISPLAY_DURATION_MS, durationMs);
}

export interface SubtitleConfig {
  fontSizePx: number;
  visible: boolean;
}

export class SubtitleRenderer {
  private containerEl: HTMLDivElement | null = null;
  private textEl: HTMLDivElement | null = null;
  private targetVideo: HTMLVideoElement | null = null;
  // Hàng đợi giữ từng câu đủ lâu để đọc; câu đến dồn không còn đè mất câu trước.
  private readonly scheduler = new SubtitleCueScheduler(cue => this.render(cue), undefined, {
    minDisplayMs: MIN_SUBTITLE_DISPLAY_DURATION_MS
  });
  private readonly onFullscreenChangeBound = () => this.mountOverlay();

  private config: SubtitleConfig = {
    fontSizePx: 22,
    visible: true
  };

  attachToVideo(video: HTMLVideoElement): void {
    this.detach();
    this.targetVideo = video;
    this.createOverlay();
    document.addEventListener('fullscreenchange', this.onFullscreenChangeBound);
  }

  private createOverlay(): void {
    if (!this.targetVideo) return;
    this.containerEl = document.createElement('div');
    this.containerEl.id = 'vietdub-subtitle-container';
    this.containerEl.style.cssText = `
      position: absolute;
      left: 5%;
      right: 5%;
      bottom: 40px;
      pointer-events: none;
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 2147483647;
      transition: opacity 0.2s ease;
    `;

    this.textEl = document.createElement('div');
    this.textEl.id = 'vietdub-subtitle-text';
    this.textEl.style.cssText = `
      background-color: rgba(0, 0, 0, 0.78);
      color: #ffffff;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 600;
      font-size: ${this.config.fontSizePx}px;
      line-height: 1.4;
      padding: 6px 16px;
      border-radius: 6px;
      text-align: center;
      max-width: 90%;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      display: none;
    `;
    this.containerEl.appendChild(this.textEl);
    this.mountOverlay();
  }

  private findOverlayParent(fullscreenElement: Element | null): HTMLElement | null {
    const video = this.targetVideo;
    if (!video) return null;
    if (fullscreenElement?.contains(video)) return fullscreenElement as HTMLElement;

    const videoRect = video.getBoundingClientRect();
    const videoArea = videoRect.width * videoRect.height;
    let parent = video.parentElement;
    const fallbackParent = parent;

    // YouTube có thể đặt video absolute trong wrapper cao 0px; leo lên player thật để overlay không nằm ngoài khung hình.
    while (parent) {
      const parentRect = parent.getBoundingClientRect();
      const overlapWidth = Math.max(
        0,
        Math.min(parentRect.right, videoRect.right) - Math.max(parentRect.left, videoRect.left)
      );
      const overlapHeight = Math.max(
        0,
        Math.min(parentRect.bottom, videoRect.bottom) - Math.max(parentRect.top, videoRect.top)
      );
      const overlapRatio = videoArea > 0 ? (overlapWidth * overlapHeight) / videoArea : 1;

      if (parentRect.width > 0 && parentRect.height > 0 && overlapRatio >= 0.5) return parent;
      if (parent === document.body) break;
      parent = parent.parentElement;
    }

    return fallbackParent;
  }

  private mountOverlay(): void {
    if (!this.targetVideo || !this.containerEl) return;
    const fullscreenElement = document.fullscreenElement;
    const parent = this.findOverlayParent(fullscreenElement);
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') {
      (parent as HTMLElement).style.position = 'relative';
    }
    if (this.containerEl.parentElement !== parent) parent.appendChild(this.containerEl);
    this.containerEl.style.bottom = fullscreenElement ? '8%' : '40px';
  }

  showSubtitle(
    segmentId: string,
    text: string,
    durationMs = 4000,
    generation = 0,
    timing: { startMs?: number; endMs?: number } = {}
  ): boolean {
    const accepted = this.textEl && this.config.visible
      ? this.scheduler.push({ segmentId, text, durationMs, generation, ...timing })
      : false;
    if (!accepted) {
      emitDiagnostic('subtitle_renderer', 'display_skipped', {
        hasTextElement: Boolean(this.textEl),
        visible: this.config.visible,
        generation,
        textLength: text.length
      });
      return false;
    }
    emitDiagnostic('subtitle_renderer', 'queued', {
      textLength: text.length,
      durationMs,
      generation,
      queued: this.scheduler.getQueuedCount()
    });
    return true;
  }

  /**
   * Phụ đề đồng bộ với giọng đọc: hiện ngay (đúng lúc giọng đọc bắt đầu) trong suốt thời lượng giọng đọc
   * cộng một khoảng ngắn để kịp đọc hết.
   */
  showSyncedSubtitle(
    segmentId: string,
    text: string,
    ttsDurationMs: number | undefined,
    generation: number,
    timing: { startMs?: number; endMs?: number } = {}
  ): boolean {
    if (!this.textEl || !this.config.visible) {
      emitDiagnostic('subtitle_renderer', 'display_skipped', {
        hasTextElement: Boolean(this.textEl),
        visible: this.config.visible,
        generation,
        textLength: text.length
      });
      return false;
    }
    const durationMs = Number.isFinite(ttsDurationMs) && (ttsDurationMs as number) > 0
      ? Math.max(MIN_SUBTITLE_DISPLAY_DURATION_MS, (ttsDurationMs as number) + SYNCED_SUBTITLE_TAIL_MS)
      : resolveSubtitleDisplayDurationMs(timing.startMs ?? 0, timing.endMs ?? 0);
    return this.scheduler.showNow({ segmentId, text, durationMs, generation, ...timing });
  }

  invalidateGeneration(generation: number): void {
    this.scheduler.invalidate(generation);
  }

  hideSubtitle(segmentId?: string): void {
    const current = this.scheduler.getCurrent();
    if (segmentId && current?.segmentId !== segmentId) return;
    this.scheduler.clear();
    this.render(null);
  }

  private render(cue: SubtitleCue | null): void {
    if (!this.textEl) return;
    if (!cue) {
      this.textEl.style.display = 'none';
      this.textEl.textContent = '';
      return;
    }
    this.textEl.textContent = cue.text;
    this.textEl.style.display = 'block';
    const videoMs = this.targetVideo ? Math.round(this.targetVideo.currentTime * 1000) : undefined;
    emitDiagnostic('subtitle_renderer', 'displayed', {
      segmentId: cue.segmentId,
      textLength: cue.text.length,
      durationMs: cue.durationMs,
      generation: cue.generation,
      // Độ trễ người xem cảm nhận: từ lúc câu gốc bắt đầu/kết thúc trên video tới lúc phụ đề hiện.
      videoMs,
      lagFromStartMs: videoMs !== undefined && cue.startMs !== undefined ? videoMs - cue.startMs : undefined,
      lagFromEndMs: videoMs !== undefined && cue.endMs !== undefined ? videoMs - cue.endMs : undefined
    });
  }

  setFontSize(sizePx: number): void {
    this.config.fontSizePx = Math.max(14, Math.min(48, sizePx));
    if (this.textEl) this.textEl.style.fontSize = `${this.config.fontSizePx}px`;
  }

  setVisible(visible: boolean): void {
    this.config.visible = visible;
    if (!visible) this.hideSubtitle();
  }

  detach(): void {
    this.hideSubtitle();
    if (this.containerEl?.parentElement) this.containerEl.parentElement.removeChild(this.containerEl);
    this.containerEl = null;
    this.textEl = null;
    this.targetVideo = null;
    document.removeEventListener('fullscreenchange', this.onFullscreenChangeBound);
  }
}
