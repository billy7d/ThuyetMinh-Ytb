import { VideoPlaybackState } from '@vietdub/shared';

export interface VideoSyncCallbacks {
  onStateChange: (state: VideoPlaybackState) => void;
  onSeek: (fromMs: number, toMs: number) => void;
  onPause: () => void;
  onResume: () => void;
}

export class VideoSyncController {
  private video: HTMLVideoElement;
  private callbacks: VideoSyncCallbacks;
  private lastTimeMs: number = 0;
  private isSeeking: boolean = false;
  private ttsAudioQueue: Array<{
    segmentId: string;
    audioBuffer: AudioBuffer;
    startMs: number;
    endMs: number;
    generation: number;
  }> = [];
  private activeTTSSource: AudioBufferSourceNode | null = null;
  private currentGeneration: number = 1;
  private destroyed = false;

  // Listeners stored for cleanup
  private onTimeUpdateBound: () => void;
  private onPlayBound: () => void;
  private onPauseBound: () => void;
  private onSeekingBound: () => void;
  private onSeekedBound: () => void;
  private onRateChangeBound: () => void;

  constructor(video: HTMLVideoElement, callbacks: VideoSyncCallbacks) {
    this.video = video;
    this.callbacks = callbacks;
    this.lastTimeMs = Math.round(video.currentTime * 1000);

    this.onTimeUpdateBound = () => this.handleTimeUpdate();
    this.onPlayBound = () => this.handlePlay();
    this.onPauseBound = () => this.handlePause();
    this.onSeekingBound = () => this.handleSeeking();
    this.onSeekedBound = () => this.handleSeeked();
    this.onRateChangeBound = () => this.handleRateChange();

    this.attachListeners();
    this.emitState();
  }

  private attachListeners(): void {
    this.video.addEventListener('timeupdate', this.onTimeUpdateBound);
    this.video.addEventListener('play', this.onPlayBound);
    this.video.addEventListener('pause', this.onPauseBound);
    this.video.addEventListener('seeking', this.onSeekingBound);
    this.video.addEventListener('seeked', this.onSeekedBound);
    this.video.addEventListener('ratechange', this.onRateChangeBound);
  }

  private handleTimeUpdate(): void {
    const currentMs = Math.round(this.video.currentTime * 1000);
    // Detect jump/seek if time discrepancy is greater than 1.5s
    const diff = Math.abs(currentMs - this.lastTimeMs);
    if (!this.isSeeking && diff > 1500) {
      this.handleSeek(this.lastTimeMs, currentMs);
    }
    this.lastTimeMs = currentMs;
  }

  private handlePlay(): void {
    this.callbacks.onResume();
    this.emitState();
  }

  private handlePause(): void {
    this.stopActiveTTS();
    this.callbacks.onPause();
    this.emitState();
  }

  private handleSeeking(): void {
    this.isSeeking = true;
    this.stopActiveTTS();
    this.clearTTSQueue();
  }

  private handleSeeked(): void {
    const currentMs = Math.round(this.video.currentTime * 1000);
    this.handleSeek(this.lastTimeMs, currentMs);
    this.isSeeking = false;
    this.lastTimeMs = currentMs;
  }

  private handleSeek(fromMs: number, toMs: number): void {
    this.currentGeneration++;
    this.stopActiveTTS();
    this.clearTTSQueue();
    this.callbacks.onSeek(fromMs, toMs);
    this.emitState();
  }

  private handleRateChange(): void {
    this.emitState();
  }

  private emitState(): void {
    this.callbacks.onStateChange({
      currentTime: this.video.currentTime,
      duration: isNaN(this.video.duration) ? 0 : this.video.duration,
      paused: this.video.paused,
      playbackRate: this.video.playbackRate,
      seeking: this.isSeeking
    });
  }

  enqueueTTSAudio(item: {
    segmentId: string;
    audioBuffer: AudioBuffer;
    startMs: number;
    endMs: number;
    generation: number;
  }): void {
    // Only queue if matching current generation and not paused
    if (item.generation === this.currentGeneration) {
      this.ttsAudioQueue.push(item);
    }
  }

  getTTSQueue() {
    return this.ttsAudioQueue;
  }

  setActiveTTSSource(source: AudioBufferSourceNode | null): void {
    this.activeTTSSource = source;
  }

  stopActiveTTS(): void {
    if (this.activeTTSSource) {
      try {
        this.activeTTSSource.stop();
      } catch (error) {
        console.warn('[VideoSync] TTS source stop failed', JSON.stringify({ code: 'TTS_SOURCE_STOP_FAILED', message: String(error) }));
      }
      try {
        this.activeTTSSource.disconnect();
      } catch (error) {
        console.warn('[VideoSync] TTS source disconnect failed', JSON.stringify({ code: 'TTS_SOURCE_DISCONNECT_FAILED', message: String(error) }));
      }
      this.activeTTSSource = null;
    }
  }

  clearTTSQueue(): void {
    this.ttsAudioQueue = [];
  }

  getCurrentGeneration(): number {
    return this.currentGeneration;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopActiveTTS();
    this.clearTTSQueue();
    this.video.removeEventListener('timeupdate', this.onTimeUpdateBound);
    this.video.removeEventListener('play', this.onPlayBound);
    this.video.removeEventListener('pause', this.onPauseBound);
    this.video.removeEventListener('seeking', this.onSeekingBound);
    this.video.removeEventListener('seeked', this.onSeekedBound);
    this.video.removeEventListener('ratechange', this.onRateChangeBound);
  }
}
