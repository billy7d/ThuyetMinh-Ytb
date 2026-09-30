import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoSyncController, VideoSyncCallbacks } from '../../extension/src/sync/video-sync.js';

describe('VideoSyncController', () => {
  afterEach(() => vi.useRealTimers());

  it('gửi cập nhật vị trí video định kỳ khi phát liên tục', () => {
    vi.useFakeTimers();
    const video = Object.assign(new EventTarget(), {
      currentTime: 120,
      duration: 600,
      paused: false,
      playbackRate: 1
    }) as HTMLVideoElement;
    const states: number[] = [];
    const callbacks: VideoSyncCallbacks = {
      onStateChange: (state) => states.push(state.currentTime),
      onSeek: () => {},
      onPause: () => {},
      onResume: () => {}
    };
    const controller = new VideoSyncController(video, callbacks);

    video.currentTime = 120.25;
    video.dispatchEvent(new Event('timeupdate'));
    expect(states).toEqual([120]);

    vi.advanceTimersByTime(201);
    video.currentTime = 120.5;
    video.dispatchEvent(new Event('timeupdate'));

    expect(states).toEqual([120, 120.5]);
    controller.destroy();
  });
});
