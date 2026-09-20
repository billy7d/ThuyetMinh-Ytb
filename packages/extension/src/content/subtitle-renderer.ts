import { emitDiagnostic } from '@vietdub/shared';

export const MIN_SUBTITLE_DISPLAY_DURATION_MS = 1500;

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
  private currentSegmentId: string | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentGeneration = 0;
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

  private mountOverlay(): void {
    if (!this.targetVideo || !this.containerEl) return;
    const fullscreenElement = document.fullscreenElement;
    const parent = fullscreenElement && fullscreenElement.contains(this.targetVideo)
      ? fullscreenElement
      : this.targetVideo.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') {
      (parent as HTMLElement).style.position = 'relative';
    }
    if (this.containerEl.parentElement !== parent) parent.appendChild(this.containerEl);
    this.containerEl.style.bottom = fullscreenElement ? '8%' : '40px';
  }

  showSubtitle(segmentId: string, text: string, durationMs = 4000, generation = 0): boolean {
    if (!this.textEl || !this.config.visible || generation < this.currentGeneration) {
      emitDiagnostic('subtitle_renderer', 'display_skipped', {
        hasTextElement: Boolean(this.textEl),
        visible: this.config.visible,
        generation,
        currentGeneration: this.currentGeneration,
        textLength: text.length
      });
      return false;
    }
    this.currentGeneration = generation;
    this.currentSegmentId = segmentId;
    this.textEl.textContent = text;
    this.textEl.style.display = 'block';
    if (this.hideTimeout) clearTimeout(this.hideTimeout);
    this.hideTimeout = setTimeout(
      () => this.hideSubtitle(segmentId),
      Math.max(MIN_SUBTITLE_DISPLAY_DURATION_MS, Math.min(10000, durationMs))
    );
    emitDiagnostic('subtitle_renderer', 'displayed', {
      textLength: text.length,
      durationMs: Math.max(MIN_SUBTITLE_DISPLAY_DURATION_MS, durationMs),
      generation
    });
    return true;
  }

  invalidateGeneration(generation: number): void {
    if (generation < this.currentGeneration) return;
    this.currentGeneration = generation;
    this.hideSubtitle();
  }

  hideSubtitle(segmentId?: string): void {
    if (segmentId && this.currentSegmentId !== segmentId) return;
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.textEl) {
      this.textEl.style.display = 'none';
      this.textEl.textContent = '';
    }
    this.currentSegmentId = null;
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
