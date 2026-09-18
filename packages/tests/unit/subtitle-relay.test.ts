import { describe, expect, it, vi } from 'vitest';
import { relaySubtitleEvent } from '../../extension/src/background/subtitle-relay.js';

const subtitleEvent = {
  type: 'SUBTITLE_EVENT' as const,
  sessionId: 'session_current',
  timestamp: 123,
  segmentId: 'seg_1',
  text: 'Phụ đề kiểm thử.',
  startMs: 0,
  endMs: 4000,
  action: 'show' as const
};

describe('Chrome background subtitle relay', () => {
  it('chuyển nguyên vẹn SUBTITLE_EVENT tới content của session hiện tại', async () => {
    const send = vi.fn(async () => ({ success: true }));

    await expect(relaySubtitleEvent(subtitleEvent, {
      sessionId: 'session_current',
      tabId: 17,
      send
    })).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(17, subtitleEvent);
  });

  it('bỏ qua subtitle của session cũ hoặc khi chưa có tab đích', async () => {
    const send = vi.fn(async () => ({ success: true }));

    await expect(relaySubtitleEvent(subtitleEvent, {
      sessionId: 'session_old',
      tabId: 17,
      send
    })).resolves.toBe(false);
    await expect(relaySubtitleEvent(subtitleEvent, {
      sessionId: 'session_current',
      tabId: null,
      send
    })).resolves.toBe(false);

    expect(send).not.toHaveBeenCalled();
  });
});
