import { describe, expect, it } from 'vitest';
import { AudioMixer } from '../../extension/src/audio/mixer.js';

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];

  connect(node: FakeAudioNode): FakeAudioNode {
    this.connections.push(node);
    return node;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number) => {
      this.gain.value = value;
    }
  };
}

function createFakeAudioContext(): { context: AudioContext; source: FakeAudioNode; destination: FakeAudioNode; gains: FakeGainNode[] } {
  const source = new FakeAudioNode();
  const destination = new FakeAudioNode();
  const gains: FakeGainNode[] = [];
  const context = {
    currentTime: 0,
    destination,
    createGain: () => {
      const gain = new FakeGainNode();
      gains.push(gain);
      return gain;
    }
  } as unknown as AudioContext;
  return { context, source, destination, gains };
}

describe('AudioMixer production graph', () => {
  it('không nối captureStream vào destination lần hai và khôi phục volume/mute idempotent', () => {
    const { context, source } = createFakeAudioContext();
    const video = { volume: 0.8, muted: false } as HTMLMediaElement;
    const mixer = new AudioMixer(context, source as unknown as MediaStreamAudioSourceNode, {
      sourceMode: 'capture-stream',
      videoElement: video,
      initialConfig: { originalVolume: 50, originalMuted: false, ttsVolume: 100 }
    });

    expect(source.connections).toHaveLength(1);
    expect(video.volume).toBeCloseTo(0.4);
    mixer.setOriginalMuted(true);
    expect(video.volume).toBe(0);

    mixer.disconnect();
    mixer.disconnect();
    expect(video).toEqual({ volume: 0.8, muted: false });
  });

  it('media-stream nối cả nhánh STT và output gốc qua gain riêng', () => {
    const { context, source, destination, gains } = createFakeAudioContext();
    const mixer = new AudioMixer(context, source as unknown as MediaStreamAudioSourceNode, {
      sourceMode: 'media-stream',
      initialConfig: { originalVolume: 25, originalMuted: false, ttsVolume: 75 }
    });

    expect(source.connections).toHaveLength(2);
    expect(gains.filter((gain) => gain.connections.includes(destination))).toHaveLength(2);
    expect((mixer.getConfig()).originalVolume).toBe(25);
    expect((mixer.getConfig()).ttsVolume).toBe(75);
    mixer.disconnect();
  });
});
