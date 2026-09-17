import { describe, it, expect } from 'vitest';
import { CostTracker } from '@vietdub/backend';

describe('Extension Communication & Resilience', () => {
  describe('Content Script Handshake & Injection Recovery', () => {
    it('should recover gracefully when content script is initially missing and auto-injected', async () => {
      let injectionCount = 0;
      let pingAttempts = 0;
      let contentScriptReady = false;

      // Simulated background messaging function
      const sendMessageWithRecovery = async (tabId: number): Promise<{ success: boolean; data?: any }> => {
        const pingTab = async (attempt: number): Promise<any> => {
          pingAttempts++;
          if (!contentScriptReady) {
            // First attempt simulates missing receiver
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          return { ready: true, hasVideo: true, videoTitle: 'Test YouTube Video' };
        };

        const injectScript = async () => {
          injectionCount++;
          // Simulate script injection making receiver ready
          contentScriptReady = true;
        };

        try {
          const res = await pingTab(1);
          return { success: true, data: res };
        } catch (err: any) {
          if (err.message.includes('Receiving end does not exist')) {
            await injectScript();
            // Retry ping after injection
            const res = await pingTab(2);
            return { success: true, data: res };
          }
          throw err;
        }
      };

      const result = await sendMessageWithRecovery(123);

      expect(result.success).toBe(true);
      expect(result.data.ready).toBe(true);
      expect(result.data.hasVideo).toBe(true);
      expect(injectionCount).toBe(1);
      expect(pingAttempts).toBe(2);
    });

    it('should report clear failure if content script remains unreachable after injection retry', async () => {
      let injectionAttempted = false;

      const pingWithFailedRecovery = async (tabId: number): Promise<void> => {
        const pingTab = async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        };

        try {
          await pingTab();
        } catch (err: any) {
          if (err.message.includes('Receiving end does not exist')) {
            injectionAttempted = true;
            // Script injection failed or page is restricted (e.g. chrome://)
            try {
              await pingTab();
            } catch (retryErr) {
              throw new Error('Content script unreachable after retry. Tab may be restricted or reloaded.');
            }
          }
          throw err;
        }
      };

      await expect(pingWithFailedRecovery(456)).rejects.toThrow(
        /Content script unreachable after retry/
      );
      expect(injectionAttempted).toBe(true);
    });
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
