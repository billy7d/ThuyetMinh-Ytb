import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioContextBlockedError, ensureAudioContextRunning } from '../../extension/src/audio/audio-context-guard.js';
import { classifyRuntimeError } from '../../extension/src/errors/runtime-errors.js';

type FakeContext = { state: AudioContextState; resume: () => Promise<void> };

describe('AudioContext bị Firefox chặn (autoplay policy)', () => {
  afterEach(() => vi.useRealTimers());

  it('không chờ khi context đã chạy', async () => {
    const resume = vi.fn(async () => {});
    await expect(ensureAudioContextRunning({ state: 'running', resume })).resolves.toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
  });

  it('chạy tiếp khi resume() thành công', async () => {
    const context: FakeContext = {
      state: 'suspended',
      resume: async () => {
        context.state = 'running';
      }
    };
    await expect(ensureAudioContextRunning(context)).resolves.toBeUndefined();
  });

  it('báo lỗi rõ ràng thay vì treo mãi khi resume() không bao giờ hoàn thành (Firefox chặn)', async () => {
    vi.useFakeTimers();
    const context: FakeContext = { state: 'suspended', resume: () => new Promise<void>(() => {}) };
    const outcome = ensureAudioContextRunning(context, 3_000).then(() => 'ok', error => error);
    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(AudioContextBlockedError);
    expect(error).toMatchObject({ code: 'AUDIO_CONTEXT_BLOCKED' });
  });

  it('báo lỗi khi resume() xong nhưng context vẫn không chạy', async () => {
    const context: FakeContext = { state: 'suspended', resume: async () => {} };
    await expect(ensureAudioContextRunning(context)).rejects.toBeInstanceOf(AudioContextBlockedError);
  });

  it('popup hiện hướng dẫn bấm vào video thay vì "nạp model"', () => {
    const classified = classifyRuntimeError('Firefox đang chặn âm thanh', 'AUDIO_CONTEXT_BLOCKED');
    expect(classified.message).toContain('chặn âm thanh');
    expect(classified.hint).toContain('Play');
    expect(classified.hint.toLowerCase()).not.toContain('model');
  });
});
