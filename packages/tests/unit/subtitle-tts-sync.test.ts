import { describe, expect, it } from 'vitest';
import type { SubtitleEventMessage } from '@vietdub/shared';
import { SentenceCompletionGuard } from '@vietdub/backend';
import { SyncedSubtitleRelease, TtsSubtitleSync, TtsSubtitleSyncClock } from '../../extension/src/sync/tts-subtitle-sync.js';
import { SubtitleCue, SubtitleCueScheduler, SubtitleSchedulerClock } from '../../extension/src/content/subtitle-scheduler.js';
import { AudioMixer, ttsPlaybackRateForSlot } from '../../extension/src/audio/mixer.js';

/** Đồng hồ giả: chạy timer theo thời gian ảo để kiểm tra đúng thời điểm hiển thị. */
class FakeClock implements TtsSubtitleSyncClock, SubtitleSchedulerClock {
  time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.time;

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
  }
}

function subtitle(segmentId: string, extra: Partial<SubtitleEventMessage> = {}): SubtitleEventMessage {
  return {
    type: 'SUBTITLE_EVENT',
    sessionId: 's',
    timestamp: 0,
    segmentId,
    text: `Phụ đề ${segmentId}`,
    startMs: 0,
    endMs: 1_000,
    generation: 1,
    action: 'show',
    syncWithTts: true,
    ttsDurationMs: 1_000,
    ...extra
  };
}

describe('đồng bộ phụ đề với giọng thuyết minh', () => {
  it('hiện phụ đề đúng lúc giọng đọc bắt đầu, kể cả khi giọng đọc phải xếp hàng sau câu trước', () => {
    const clock = new FakeClock();
    const released: Array<SyncedSubtitleRelease & { at: number }> = [];
    const sync = new TtsSubtitleSync(item => released.push({ ...item, at: clock.time }), clock);

    expect(sync.offer(subtitle('a'))).toBe(true);
    sync.ttsScheduled('a', 0, 1_800);
    expect(released.map(item => [item.message.segmentId, item.at, item.ttsDurationMs])).toEqual([['a', 0, 1_800]]);

    clock.advance(300);
    expect(sync.offer(subtitle('b'))).toBe(true);
    // Câu b phải chờ câu a đọc xong (còn 1.5 s).
    sync.ttsScheduled('b', 1_500, 900);
    clock.advance(1_499);
    expect(released).toHaveLength(1);
    clock.advance(1);
    expect(released.map(item => [item.message.segmentId, item.at])).toEqual([['a', 0], ['b', 1_800]]);
  });

  it('không có giọng đọc (bị bỏ/lỗi/không tới) thì vẫn hiện phụ đề, không bao giờ mất câu', () => {
    const clock = new FakeClock();
    const released: SyncedSubtitleRelease[] = [];
    const sync = new TtsSubtitleSync(item => released.push(item), clock, 1_500);

    sync.offer(subtitle('dropped'));
    sync.ttsDropped('dropped');
    expect(released.map(item => [item.message.segmentId, item.ttsDurationMs])).toEqual([['dropped', undefined]]);

    sync.offer(subtitle('lost'));
    clock.advance(1_499);
    expect(released).toHaveLength(1);
    clock.advance(1);
    expect(released.map(item => item.message.segmentId)).toEqual(['dropped', 'lost']);
  });

  it('phụ đề không đồng bộ được trả lại cho bên gọi hiển thị bình thường', () => {
    const sync = new TtsSubtitleSync(() => {}, new FakeClock());
    expect(sync.offer(subtitle('plain', { syncWithTts: undefined }))).toBe(false);
    expect(sync.heldCount()).toBe(0);
  });

  it('tua/dừng xóa mọi phụ đề đang chờ giọng đọc', () => {
    const clock = new FakeClock();
    const released: SyncedSubtitleRelease[] = [];
    const sync = new TtsSubtitleSync(item => released.push(item), clock);
    sync.offer(subtitle('a'));
    sync.ttsScheduled('a', 2_000, 500);
    sync.offer(subtitle('b'));
    sync.clear();
    clock.advance(5_000);
    expect(released).toEqual([]);
    expect(sync.heldCount()).toBe(0);
  });
});

describe('SubtitleCueScheduler.showNow', () => {
  it('thay ngay câu đang hiện thay vì xếp hàng theo thời gian đọc, và ẩn sau thời lượng giọng đọc', () => {
    const clock = new FakeClock();
    const shown: Array<SubtitleCue | null> = [];
    const scheduler = new SubtitleCueScheduler(cue => shown.push(cue), clock, { minDisplayMs: 1_500 });
    scheduler.push({ segmentId: 'old', text: 'Một câu rất dài cần nhiều thời gian để đọc hết nội dung.', durationMs: 4_000, generation: 1 });
    clock.advance(200);
    expect(scheduler.showNow({ segmentId: 'tts', text: 'Câu đang được đọc.', durationMs: 2_000, generation: 1 })).toBe(true);
    expect(shown.at(-1)?.segmentId).toBe('tts');
    clock.advance(1_999);
    expect(scheduler.getCurrent()?.segmentId).toBe('tts');
    clock.advance(1);
    expect(shown.at(-1)).toBeNull();
  });

  it('bỏ câu đồng bộ của vị trí cũ sau khi tua', () => {
    const scheduler = new SubtitleCueScheduler(() => {}, new FakeClock());
    scheduler.invalidate(3);
    expect(scheduler.showNow({ segmentId: 'x', text: 'Cũ.', durationMs: 1_000, generation: 2 })).toBe(false);
  });
});

describe('AudioMixer.scheduleTTSBuffer', () => {
  it('trả về thời gian chờ thực tế để phụ đề hiện cùng lúc giọng đọc', () => {
    const node = () => ({ connect: () => {}, disconnect: () => {}, gain: { setValueAtTime: () => {} } });
    const context = {
      currentTime: 0,
      destination: node(),
      createGain: node,
      createBufferSource: () => ({ ...node(), buffer: null, onended: null, playbackRate: { value: 1 }, start: () => {}, stop: () => {} })
    } as unknown as AudioContext;
    const mixer = new AudioMixer(context, node() as unknown as MediaStreamAudioSourceNode);
    expect(mixer.scheduleTTSBuffer({ duration: 1 } as AudioBuffer)).toMatchObject({ delayMs: 0, durationMs: 1_000 });
    // Câu thứ hai xếp sau câu đầu 1 s và đã hơi trễ nên phát nhanh 1.0625x.
    expect(mixer.scheduleTTSBuffer({ duration: 1 } as AudioBuffer)).toMatchObject({ delayMs: 1_000, durationMs: 941 });
    // Hàng chờ phát quá 3.5 s: bỏ câu để thuyết minh (và phụ đề đồng bộ) không trễ dồn.
    mixer.scheduleTTSBuffer({ duration: 3 } as AudioBuffer);
    expect(mixer.scheduleTTSBuffer({ duration: 1 } as AudioBuffer)).toBeNull();
  });
});

describe('ttsPlaybackRateForSlot', () => {
  it('chỉ tăng tốc khi giọng đọc dài hơn khung câu gốc, tối đa 1.3x', () => {
    expect(ttsPlaybackRateForSlot(2_000, 2_000)).toBe(1);
    expect(ttsPlaybackRateForSlot(2_860, 2_000)).toBeCloseTo(1.1);
    expect(ttsPlaybackRateForSlot(6_080, 2_000)).toBe(1.3);
    expect(ttsPlaybackRateForSlot(2_000, undefined)).toBe(1);
    expect(ttsPlaybackRateForSlot(2_000, 0)).toBe(1);
  });
});

describe('SentenceCompletionGuard.isTinyFragment', () => {
  const guard = new SentenceCompletionGuard();
  it('nhận ra mảnh câu cụt quá ngắn để dịch riêng', () => {
    expect(guard.isTinyFragment('There will be a')).toBe(true);
    expect(guard.isTinyFragment('And then we')).toBe(true);
    expect(guard.isTinyFragment('And then we went over to the')).toBe(false);
    // Có dấu kết thúc thì là câu hoàn chỉnh dù ngắn.
    expect(guard.isTinyFragment('Alright.')).toBe(false);
    expect(guard.isTinyFragment('How are you?')).toBe(false);
  });
});

describe('SentenceCompletionGuard.isTranslatableWithoutPunctuation', () => {
  const guard = new SentenceCompletionGuard();
  it('dịch ngay đoạn dài đủ nghĩa dù Whisper không đặt dấu câu', () => {
    expect(guard.isTranslatableWithoutPunctuation('we wanted to build something people really love')).toBe(true);
  });
  it('vẫn giữ mảnh câu cụt để ghép với câu sau', () => {
    expect(guard.isTranslatableWithoutPunctuation('There will be a')).toBe(false);
    expect(guard.isTranslatableWithoutPunctuation('and then we went over to the')).toBe(false);
    expect(guard.isTranslatableWithoutPunctuation('so this is what we did and')).toBe(false);
  });
});
