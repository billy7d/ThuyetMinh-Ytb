import { describe, it, expect, vi } from 'vitest';
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

describe('giới hạn phiên chế độ local', () => {
  it('maxSessionMinutes = 0 nghĩa là không giới hạn thời lượng', () => {
    vi.useFakeTimers();
    try {
      const tracker = new CostTracker('unlimited', { costMode: 'local', maxCostPerSessionUsd: 0, maxSessionMinutes: 0, rateLimitChunksPerSecond: 40 });
      vi.advanceTimersByTime(5 * 60 * 60 * 1000);
      expect(() => tracker.recordAudioChunk(0.25)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('vẫn chặn khi có giới hạn thời lượng và gửi dồn vượt ngưỡng', () => {
    vi.useFakeTimers();
    try {
      const limited = new CostTracker('limited', { costMode: 'local', maxCostPerSessionUsd: 0, maxSessionMinutes: 30 });
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(() => limited.recordAudioChunk(0.25)).toThrow(/duration limit/);
      const burst = new CostTracker('burst', { costMode: 'local', maxCostPerSessionUsd: 0, maxSessionMinutes: 0, rateLimitChunksPerSecond: 40 });
      for (let index = 0; index < 40; index += 1) burst.recordAudioChunk(0.25);
      expect(() => burst.recordAudioChunk(0.25)).toThrow(/Rate limit/);
    } finally {
      vi.useRealTimers();
    }
  });
});
