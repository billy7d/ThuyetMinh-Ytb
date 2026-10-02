import { describe, expect, it } from 'vitest';
import { isSameVideo, videoIdentity } from '../../extension/src/navigation/video-identity.js';

describe('video identity (phiên không bị dừng khi YouTube tự sửa URL)', () => {
  it('coi các URL cùng video YouTube là một dù query thay đổi', () => {
    const base = 'https://www.youtube.com/watch?v=iG9CE55wbtY';
    expect(isSameVideo(base, 'https://www.youtube.com/watch?v=iG9CE55wbtY&t=42s')).toBe(true);
    expect(isSameVideo(base, 'https://www.youtube.com/watch?v=iG9CE55wbtY&pp=ygUDdGVk&list=PL1')).toBe(true);
    expect(isSameVideo(base, 'https://m.youtube.com/watch?v=iG9CE55wbtY')).toBe(true);
    expect(isSameVideo(base, 'https://youtu.be/iG9CE55wbtY?si=abc')).toBe(true);
  });

  it('nhận ra khi thật sự chuyển sang video khác', () => {
    expect(isSameVideo('https://www.youtube.com/watch?v=aaa', 'https://www.youtube.com/watch?v=bbb')).toBe(false);
    expect(videoIdentity('https://www.youtube.com/shorts/xyz123')).toBe('youtube:xyz123');
    expect(isSameVideo('https://example.com/video/1?autoplay=1', 'https://example.com/video/1#t=5')).toBe(true);
    expect(isSameVideo('https://example.com/video/1', 'https://example.com/video/2')).toBe(false);
  });
});
