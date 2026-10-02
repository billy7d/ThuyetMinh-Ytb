import { describe, expect, it, vi } from 'vitest';
import { SessionManager, SessionRuntime } from '../../extension/src/background/session-manager.js';
import { SubtitleCue, SubtitleCueScheduler, SubtitleSchedulerClock } from '../../extension/src/content/subtitle-scheduler.js';
import { classifyRuntimeError, isRetryableServerError } from '../../extension/src/errors/runtime-errors.js';
import { AudioMixer, ttsPlaybackRateForBacklog } from '../../extension/src/audio/mixer.js';

function runtimeMock(): SessionRuntime {
  return {
    ensureReady: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  };
}

describe('SessionManager non-fatal errors (P0)', () => {
  it('giữ phiên ACTIVE và chỉ ghi cảnh báo khi backend báo lỗi không nghiêm trọng', async () => {
    const runtime = runtimeMock();
    const manager = new SessionManager('test', runtime);
    await manager.start({ tabId: 1, mode: 'dubbing_and_subtitle', mixerConfig: { originalVolume: 30, originalMuted: false, ttsVolume: 80 } });
    const sessionId = manager.getSnapshot().sessionId!;

    await manager.handleRuntimeEvent({
      sessionId,
      error: { code: 'STT_OVERLOADED', message: 'busy', retryable: false, fatal: false }
    });
    const snapshot = manager.getSnapshot();
    expect(snapshot.state).toBe('ACTIVE');
    expect(snapshot.error).toBeNull();
    expect(snapshot.warning).toMatchObject({ code: 'STT_OVERLOADED', fatal: false });
    expect(runtime.stop).not.toHaveBeenCalled();

    await manager.handleRuntimeEvent({
      sessionId,
      error: { code: 'STT_UNAVAILABLE', message: 'dead', retryable: true, fatal: true }
    });
    expect(manager.getSnapshot()).toMatchObject({ state: 'ERROR', error: { code: 'STT_UNAVAILABLE' }, warning: null });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('xóa cảnh báo khi người dùng dừng phiên', async () => {
    const manager = new SessionManager('test', runtimeMock());
    await manager.start({ tabId: 2, mode: 'subtitle_only', mixerConfig: { originalVolume: 30, originalMuted: false, ttsVolume: 80 } });
    await manager.handleRuntimeEvent({
      sessionId: manager.getSnapshot().sessionId!,
      error: { code: 'TTS_ERROR', message: 'x', fatal: false }
    });
    await manager.stop('user');
    expect(manager.getSnapshot()).toMatchObject({ state: 'IDLE', warning: null });
  });
});

class FakeClock implements SubtitleSchedulerClock {
  time = 0;
  private timers: Array<{ at: number; callback: () => void; id: number }> = [];
  private nextId = 1;

  now = () => this.time;
  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.time + delayMs, callback, id });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter(timer => timer.id !== handle);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.time = next.at;
      next.callback();
    }
    this.time = target;
  }
}

describe('SubtitleCueScheduler (P1)', () => {
  const cue = (index: number, generation = 1, text = `Câu số ${index}.`): SubtitleCue => ({
    segmentId: `seg_${index}`,
    text,
    durationMs: 3_000,
    generation
  });

  it('hiển thị lần lượt cả ba câu đến dồn thay vì chỉ câu cuối', () => {
    const clock = new FakeClock();
    const shown: Array<string | null> = [];
    const scheduler = new SubtitleCueScheduler(item => shown.push(item?.text ?? null), clock);
    scheduler.push(cue(1));
    scheduler.push(cue(2));
    scheduler.push(cue(3));
    expect(shown).toEqual(['Câu số 1.']);
    clock.advance(1_500);
    clock.advance(1_500);
    clock.advance(4_000);
    expect(shown).toEqual(['Câu số 1.', 'Câu số 2.', 'Câu số 3.', null]);
  });

  it('gộp câu cũ khi hàng đợi quá dài để không mất nội dung', () => {
    const clock = new FakeClock();
    const shown: Array<string | null> = [];
    const scheduler = new SubtitleCueScheduler(item => shown.push(item?.text ?? null), clock, { maxQueued: 2 });
    for (let index = 1; index <= 5; index += 1) scheduler.push(cue(index));
    clock.advance(20_000);
    const visible = shown.filter((text): text is string => Boolean(text)).join(' ');
    for (let index = 1; index <= 5; index += 1) expect(visible).toContain(`Câu số ${index}.`);
  });

  it('bỏ câu của generation cũ và xóa hàng đợi khi tua', () => {
    const clock = new FakeClock();
    const shown: Array<string | null> = [];
    const scheduler = new SubtitleCueScheduler(item => shown.push(item?.text ?? null), clock);
    scheduler.push(cue(1, 1));
    scheduler.push(cue(2, 1));
    expect(scheduler.push(cue(9, 2))).toBe(true);
    expect(scheduler.push(cue(3, 1))).toBe(false);
    clock.advance(20_000);
    expect(shown).toEqual(['Câu số 1.', 'Câu số 9.', null]);
  });
});

describe('runtime error classification (P0)', () => {
  it('không khuyên tải lại trang cho lỗi quá tải/khởi động của backend', () => {
    for (const code of ['STT_OVERLOADED', 'PIPELINE_BACKPRESSURE', 'LOCAL_RUNTIME_WARMING', 'STT_UNAVAILABLE', 'TTS_ERROR']) {
      const classified = classifyRuntimeError('x', code);
      expect(classified.hint.toLowerCase()).not.toContain('tải lại trang');
      expect(classified.message).not.toBe('x');
    }
    expect(classifyRuntimeError('Hết thời gian chờ phản hồi từ máy chủ AI.', 'WS_CONNECTION_TIMEOUT').message).toBe('Không thể kết nối máy chủ AI.');
    expect(classifyRuntimeError('Permission denied', 'PERMISSION_DENIED').message).toContain('quyền');
  });

  it('đánh dấu lỗi tạm thời là có thể thử lại', () => {
    expect(isRetryableServerError('LOCAL_RUNTIME_WARMING')).toBe(true);
    expect(isRetryableServerError('UNSUPPORTED_AUDIO_FORMAT')).toBe(false);
    expect(isRetryableServerError(undefined)).toBe(false);
  });
});

describe('AudioMixer TTS backlog guard (P1)', () => {
  it('bỏ câu mới khi hàng chờ phát đã quá dài', () => {
    const node = () => ({ connect: () => {}, disconnect: () => {}, gain: { setValueAtTime: () => {} } });
    const context = {
      currentTime: 0,
      destination: node(),
      createGain: node,
      createBufferSource: () => ({ ...node(), buffer: null, onended: null, start: () => {}, stop: () => {} })
    } as unknown as AudioContext;
    const mixer = new AudioMixer(context, node() as unknown as MediaStreamAudioSourceNode);
    const buffer = { duration: 3 } as AudioBuffer;
    expect(mixer.playTTSBuffer(buffer)).not.toBeNull();
    // Câu thứ hai bắt đầu khi đã trễ 3 s nên được phát nhanh 1.3x (~2.3 s thực).
    expect(mixer.playTTSBuffer(buffer)).not.toBeNull();
    expect(mixer.getTTSBacklogMs()).toBeCloseTo(3_000 + 3_000 / 1.3, -1);
    expect(mixer.playTTSBuffer(buffer)).toBeNull();
    mixer.stopTTS();
    expect(mixer.playTTSBuffer(buffer)).not.toBeNull();
  });

  it('chỉ tăng tốc phát khi đã trễ và không vượt 1.3x', () => {
    expect(ttsPlaybackRateForBacklog(0)).toBe(1);
    expect(ttsPlaybackRateForBacklog(500)).toBe(1);
    expect(ttsPlaybackRateForBacklog(2_000)).toBeCloseTo(1.1875);
    expect(ttsPlaybackRateForBacklog(60_000)).toBe(1.3);
    expect(ttsPlaybackRateForBacklog(Number.NaN)).toBe(1);
  });
});
