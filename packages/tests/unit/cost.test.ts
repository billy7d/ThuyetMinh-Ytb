import { describe, it, expect } from 'vitest';
import { CostTracker } from '@vietdub/backend';

describe('CostTracker & Budget Guard', () => {
  it('should track usage and compute estimated USD cost correctly', () => {
    const tracker = new CostTracker('session_test_1');

    // 60 seconds of audio
    tracker.recordAudioChunk(60);
    // 500 English characters translated
    tracker.recordTranslation(500);
    // 600 Vietnamese characters synthesized
    tracker.recordTTS(600);

    const metrics = tracker.getMetrics();
    expect(metrics.sessionId).toBe('session_test_1');
    expect(metrics.sttSeconds).toBe(60);
    expect(metrics.translatedCharacters).toBe(500);
    expect(metrics.ttsCharacters).toBe(600);
    expect(metrics.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('should trigger budget guard when session cost exceeds configured maximum', () => {
    const strictTracker = new CostTracker('strict_session', { maxCostPerSessionUsd: 0.05 });

    expect(() => {
      // 5000 seconds of audio (~$1.33)
      strictTracker.recordAudioChunk(5000);
    }).toThrow(/Budget guard triggered/);
  });

  it('should calculate one-hour cost projection accurately', () => {
    const projection = CostTracker.calculateOneHourCostProjection({
      wordsPerMinute: 150,
      speechRatio: 0.8
    });

    expect(projection.durationHours).toBe(1);
    expect(projection.speechMinutes).toBe(48);
    expect(projection.sttCostUsd).toBeGreaterThan(0.7);
    expect(projection.totalCostUsd).toBeGreaterThan(0);
    expect(projection.breakdownPercentage.stt).toBeGreaterThan(0);
  });

  it('should enforce rate limit of 10 chunks per second', () => {
    const tracker = new CostTracker('rate_limit_test', { rateLimitChunksPerSecond: 10 });
    // 10 chunks within the same second should succeed
    for (let i = 0; i < 10; i++) {
      expect(tracker.recordAudioChunk(0.25)).toBe(true);
    }
    // 11th chunk within the same second must throw rate limit error
    expect(() => tracker.recordAudioChunk(0.25)).toThrow(/Rate limit exceeded/);
  });
});
