import { AudioMixerConfig, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME } from '@vietdub/shared';

export class AudioMixer {
  private audioCtx: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode;
  private originalGainNode: GainNode;
  private ttsGainNode: GainNode;
  private sttTapNode: GainNode;
  private ttsSources = new Set<AudioBufferSourceNode>();
  private nextTTSStartTime = 0;

  private config: AudioMixerConfig = {
    originalVolume: DEFAULT_ORIGINAL_VOLUME,
    originalMuted: false,
    ttsVolume: DEFAULT_TTS_VOLUME
  };

  constructor(
    audioCtx: AudioContext,
    sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode
  ) {
    this.audioCtx = audioCtx;
    this.sourceNode = sourceNode;

    this.originalGainNode = audioCtx.createGain();
    this.ttsGainNode = audioCtx.createGain();
    this.sttTapNode = audioCtx.createGain();

    this.setupGraph();
    this.applyConfig();
  }

  private setupGraph(): void {
    // 1. Connect source to STT Tap (BEFORE original volume control)
    // This ensures muting the original video does NOT mute the AI input!
    this.sourceNode.connect(this.sttTapNode);

    // 2. Connect source to original gain node -> speaker destination
    this.sourceNode.connect(this.originalGainNode);
    this.originalGainNode.connect(this.audioCtx.destination);

    // 3. TTS gain node connects directly to speaker destination
    this.ttsGainNode.connect(this.audioCtx.destination);
  }

  getSTTTapNode(): GainNode {
    return this.sttTapNode;
  }

  getTTSDestination(): GainNode {
    return this.ttsGainNode;
  }

  setOriginalVolume(volumePercent: number): void {
    this.config.originalVolume = Math.max(0, Math.min(100, volumePercent));
    this.applyConfig();
  }

  setOriginalMuted(muted: boolean): void {
    this.config.originalMuted = muted;
    this.applyConfig();
  }

  setTTSVolume(volumePercent: number): void {
    this.config.ttsVolume = Math.max(0, Math.min(100, volumePercent));
    this.applyConfig();
  }

  getConfig(): AudioMixerConfig {
    return { ...this.config };
  }

  private applyConfig(): void {
    const origGain = this.config.originalMuted ? 0 : this.config.originalVolume / 100.0;
    this.originalGainNode.gain.setValueAtTime(origGain, this.audioCtx.currentTime);

    const ttsGain = this.config.ttsVolume / 100.0;
    this.ttsGainNode.gain.setValueAtTime(ttsGain, this.audioCtx.currentTime);
  }

  /**
   * Play a decoded AudioBuffer on the TTS channel
   */
  playTTSBuffer(audioBuffer: AudioBuffer): AudioBufferSourceNode {
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ttsGainNode);
    const startAt = Math.max(this.audioCtx.currentTime, this.nextTTSStartTime);
    source.start(startAt);
    this.nextTTSStartTime = startAt + audioBuffer.duration;
    this.ttsSources.add(source);
    source.onended = () => {
      this.ttsSources.delete(source);
      try { source.disconnect(); } catch {}
    };
    return source;
  }

  stopTTS(): void {
    for (const source of this.ttsSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
    this.ttsSources.clear();
    this.nextTTSStartTime = this.audioCtx.currentTime;
  }

  getTTSBacklogMs(): number {
    return Math.max(0, Math.round((this.nextTTSStartTime - this.audioCtx.currentTime) * 1000));
  }

  disconnect(): void {
    try {
      this.stopTTS();
      this.sourceNode.disconnect();
      this.originalGainNode.disconnect();
      this.ttsGainNode.disconnect();
      this.sttTapNode.disconnect();
    } catch (err) {
      console.warn('[AudioMixer] Disconnect error:', err);
    }
  }
}
