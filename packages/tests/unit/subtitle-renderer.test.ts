import { describe, expect, it } from 'vitest';
import {
  MIN_SUBTITLE_DISPLAY_DURATION_MS,
  resolveSubtitleDisplayDurationMs
} from '../../extension/src/content/subtitle-renderer.js';

describe('subtitle display duration', () => {
  it('keeps a short backend segment visible long enough to observe', () => {
    expect(resolveSubtitleDisplayDurationMs(0, 300)).toBe(MIN_SUBTITLE_DISPLAY_DURATION_MS);
  });

  it('preserves a longer segment duration', () => {
    expect(resolveSubtitleDisplayDurationMs(1000, 5000)).toBe(4000);
  });

  it('uses a safe fallback for invalid boundaries', () => {
    expect(resolveSubtitleDisplayDurationMs(500, 500)).toBe(4000);
  });
});
