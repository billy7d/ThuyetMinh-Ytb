import { describe, it, expect } from 'vitest';
import { CostTracker } from '@vietdub/backend';
import { PCMProcessor } from '../../extension/src/audio/pcm-processor.js';

class FakeAudioNode {
  connect(node: FakeAudioNode): FakeAudioNode {
    return node;
  }

  disconnect(): void {}
}

class FakeProcessorNode extends FakeAudioNode {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null = null;
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number) => {
      this.gain.value = value;
    }
  };
}

class FakeAudioContext {
  readonly sampleRate = 48000;
  readonly destination = new FakeAudioNode();
  currentTime = 0;
  processor: FakeProcessorNode | null = null;

  createScriptProcessor(): FakeProcessorNode {
    this.processor = new FakeProcessorNode();
    return this.processor;
  }

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
}

describe('Extension Communication & Resilience', () => {
  it('phát timestamp PCM tăng đều khi một callback tạo nhiều chunk', () => {
    const context = new FakeAudioContext();
    const timestamps: number[] = [];
    new PCMProcessor(
      context as unknown as AudioContext,
      new FakeAudioNode() as unknown as AudioNode,
      (_pcmBase64, timestampMs) => timestamps.push(timestampMs),
      16000,
      4096,
      'pcm_timestamp_regression'
    );

    const inputBlock = new Float32Array(4096);
    inputBlock.fill(0.1);
    for (let index = 0; index < 13; index += 1) {
      context.currentTime = ((index + 1) * 4096) / context.sampleRate;
      context.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => inputBlock } });
    }

    expect(timestamps).toEqual([0, 250, 500, 750]);
  });

  describe('PCM Chunk Accumulator & Rate Limit Verification', () => {
    it('should accumulate audio into 250ms chunks and never exceed backend 10 chunks/s limit', () => {
      const targetSampleRate = 16000;
      const targetChunkSamples = Math.round(targetSampleRate * 0.25); // 4000 samples = 250ms
      const emittedChunks: Float32Array[] = [];

      // Test accumulator logic matching PCMProcessor
      let accumulatedSamples: Float32Array[] = [];
      let accumulatedLength = 0;

      const pushSamples = (samples: Float32Array) => {
        accumulatedSamples.push(samples);
        accumulatedLength += samples.length;

        while (accumulatedLength >= targetChunkSamples) {
          const chunk = new Float32Array(targetChunkSamples);
          let offset = 0;

          while (offset < targetChunkSamples && accumulatedSamples.length > 0) {
            const first = accumulatedSamples[0];
            const needed = targetChunkSamples - offset;

            if (first.length <= needed) {
              chunk.set(first, offset);
              offset += first.length;
              accumulatedSamples.shift();
            } else {
              chunk.set(first.subarray(0, needed), offset);
              accumulatedSamples[0] = first.subarray(needed);
              offset += needed;
            }
          }

          accumulatedLength -= targetChunkSamples;
          emittedChunks.push(chunk);
        }
      };

      // Simulate 1 full second of 16kHz audio input fed in smaller Web Audio blocks (e.g. 128 samples, ~125 blocks/s)
      const blockSize = 128;
      const totalBlocks = 16000 / blockSize; // 125 blocks

      for (let i = 0; i < totalBlocks; i++) {
        const dummyBlock = new Float32Array(blockSize);
        dummyBlock.fill(0.1);
        pushSamples(dummyBlock);
      }

      // Exactly 4 chunks of 4000 samples should be produced for 1 second of audio
      expect(emittedChunks.length).toBe(4);
      for (const chunk of emittedChunks) {
        expect(chunk.length).toBe(4000);
      }

      // Now feed these 4 chunks into CostTracker configured with 10 chunks/sec limit
      const tracker = new CostTracker('test_pcm_session', { rateLimitChunksPerSecond: 10 });
      let violations = 0;

      for (const _chunk of emittedChunks) {
        try {
          tracker.recordAudioChunk(0.25);
        } catch (err) {
          violations++;
        }
      }

      expect(violations).toBe(0);
      const metrics = tracker.getMetrics();
      expect(metrics.sttSeconds).toBe(1.0);
    });
  });
});
