export interface SubtitleConfig {
  fontSizePx: number;
  visible: boolean;
}

export class SubtitleRenderer {
  private containerEl: HTMLDivElement | null = null;
  private textEl: HTMLDivElement | null = null;
  private targetVideo: HTMLVideoElement | null = null;
  private currentSegmentId: string | null = null;
  private hideTimeout: any = null;

  private config: SubtitleConfig = {
    fontSizePx: 22,
    visible: true
  };

  constructor() {}

  attachToVideo(video: HTMLVideoElement): void {
    this.detach();
    this.targetVideo = video;
    this.createOverlay();
  }

  private createOverlay(): void {
    if (!this.targetVideo) return;

    // Create wrapper container
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

    // Create subtitle text bubble
    this.textEl = document.createElement('div');
    this.textEl.id = 'vietdub-subtitle-text';
    this.textEl.style.cssText = `
      background-color: rgba(0, 0, 0, 0.75);
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
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      display: none;
    `;

    this.containerEl.appendChild(this.textEl);

    // Insert overlay relative to video or its parent container
    const parent = this.targetVideo.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.containerEl);
    } else {
      document.body.appendChild(this.containerEl);
    }
  }

  showSubtitle(segmentId: string, text: string, durationMs: number = 4000): void {
    if (!this.textEl || !this.config.visible) return;

    this.currentSegmentId = segmentId;
    this.textEl.textContent = text;
    this.textEl.style.display = 'block';

    if (this.hideTimeout) clearTimeout(this.hideTimeout);

    this.hideTimeout = setTimeout(() => {
      this.hideSubtitle(segmentId);
    }, durationMs);
  }

  hideSubtitle(segmentId?: string): void {
    if (segmentId && this.currentSegmentId !== segmentId) return;
    if (this.textEl) {
      this.textEl.style.display = 'none';
      this.textEl.textContent = '';
    }
  }

  setFontSize(sizePx: number): void {
    this.config.fontSizePx = Math.max(14, Math.min(48, sizePx));
    if (this.textEl) {
      this.textEl.style.fontSize = `${this.config.fontSizePx}px`;
    }
  }

  setVisible(visible: boolean): void {
    this.config.visible = visible;
    if (!visible) {
      this.hideSubtitle();
    }
  }

  detach(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.containerEl && this.containerEl.parentElement) {
      this.containerEl.parentElement.removeChild(this.containerEl);
    }
    this.containerEl = null;
    this.textEl = null;
    this.targetVideo = null;
  }
}
