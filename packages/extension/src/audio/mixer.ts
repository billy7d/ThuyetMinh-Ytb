import { AudioMixerConfig, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME } from '@vietdub/shared';

export type AudioSourceMode = 'media-element' | 'capture-stream' | 'media-stream';

export interface AudioMixerOptions {
  sourceMode?: AudioSourceMode;
  videoElement?: HTMLMediaElement;
  initialConfig?: Partial<AudioMixerConfig>;
}

interface SavedVideoAudioState {
  volume: number;
  muted: boolean;
}

export class AudioMixer {
  private readonly audioCtx: AudioContext;
  private readonly sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode;
  private readonly sourceMode: AudioSourceMode;
  private readonly videoElement: HTMLMediaElement | null;
  private readonly savedVideoAudioState: SavedVideoAudioState | null;
  private readonly originalGainNode: GainNode;
  private readonly ttsGainNode: GainNode;
  private readonly sttTapNode: GainNode;
  private readonly ttsSources = new Set<AudioBufferSourceNode>();
  private disconnected = false;

  private config: AudioMixerConfig = {
    originalVolume: DEFAULT_ORIGINAL_VOLUME,
    originalMuted: false,
    ttsVolume: DEFAULT_TTS_VOLUME
  };

  constructor(
    audioCtx: AudioContext,
    sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode,
    options: AudioMixerOptions = {}
  ) {
    this.audioCtx = audioCtx;
    this.sourceNode = sourceNode;
    this.sourceMode = options.sourceMode || 'media-stream';
    this.videoElement = options.videoElement || null;
    this.savedVideoAudioState = this.videoElement
      ? { volume: this.videoElement.volume, muted: this.videoElement.muted }
      : null;
    this.config = { ...this.config, ...options.initialConfig };

    this.originalGainNode = audioCtx.createGain();
    this.ttsGainNode = audioCtx.createGain();
    this.sttTapNode = audioCtx.createGain();

    this.setupGraph();
    this.applyConfig();
  }

  private setupGraph(): void {
    // Nhánh STT luôn lấy tín hiệu trước khi giảm âm thanh gốc.
    this.sourceNode.connect(this.sttTapNode);

    // MediaElementSource đã tiếp quản đường phát của video; capture stream thì không.
    if (this.sourceMode !== 'capture-stream') {
      this.sourceNode.connect(this.originalGainNode);
      this.originalGainNode.connect(this.audioCtx.destination);
    }

    // TTS là nhánh độc lập, không phụ thuộc volume/mute của video.
    this.ttsGainNode.connect(this.audioCtx.destination);
  }

  getSTTTapNode(): GainNode {
    return this.sttTapNode;
  }

  getTTSDestination(): GainNode {
    return this.ttsGainNode;
  }

  setOriginalVolume(volumePercent: number): void {
    this.config.originalVolume = this.clampPercent(volumePercent);
    this.applyConfig();
  }

  setOriginalMuted(muted: boolean): void {
    this.config.originalMuted = muted;
    this.applyConfig();
  }

  setTTSVolume(volumePercent: number): void {
    this.config.ttsVolume = this.clampPercent(volumePercent);
    this.applyConfig();
  }

  getConfig(): AudioMixerConfig {
    return { ...this.config };
  }

  private applyConfig(): void {
    const originalGain = this.config.originalMuted ? 0 : this.config.originalVolume / 100;

    if (this.sourceMode === 'capture-stream' && this.videoElement && this.savedVideoAudioState) {
      // captureStream không điều khiển đường loa trực tiếp, vì vậy chỉ scale volume gốc.
      this.videoElement.volume = Math.max(0, Math.min(1, this.savedVideoAudioState.volume * originalGain));
    } else {
      this.originalGainNode.gain.setValueAtTime(originalGain, this.audioCtx.currentTime);
    }

    this.ttsGainNode.gain.setValueAtTime(this.config.ttsVolume / 100, this.audioCtx.currentTime);
  }

  private clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  }

  /** Phát một AudioBuffer trên nhánh TTS độc lập. */
  playTTSBuffer(audioBuffer: AudioBuffer): AudioBufferSourceNode {
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ttsGainNode);
    this.ttsSources.add(source);
    source.onended = () => this.ttsSources.delete(source);
    source.start();
    return source;
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;

    for (const source of this.ttsSources) {
      try {
        source.stop();
      } catch (error) {
        console.warn('[AudioMixer] TTS stop failed', JSON.stringify({ code: 'TTS_STOP_FAILED', message: String(error) }));
      }
      try {
        source.disconnect();
      } catch (error) {
        console.warn('[AudioMixer] TTS disconnect failed', JSON.stringify({ code: 'TTS_DISCONNECT_FAILED', message: String(error) }));
      }
    }
    this.ttsSources.clear();

    const nodes: AudioNode[] = [this.sourceNode, this.originalGainNode, this.ttsGainNode, this.sttTapNode];
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch (error) {
        console.warn('[AudioMixer] node disconnect failed', JSON.stringify({ code: 'AUDIO_NODE_DISCONNECT_FAILED', message: String(error) }));
      }
    }

    if (this.videoElement && this.savedVideoAudioState) {
      try {
        // Khôi phục đúng volume/mute trước khi extension chiếm đường âm thanh.
        this.videoElement.volume = this.savedVideoAudioState.volume;
        this.videoElement.muted = this.savedVideoAudioState.muted;
      } catch (error) {
        console.error('[AudioMixer] video audio restore failed', JSON.stringify({ code: 'VIDEO_AUDIO_RESTORE_FAILED', message: String(error) }));
      }
    }
  }
}
