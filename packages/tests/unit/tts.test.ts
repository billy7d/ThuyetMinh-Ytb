import { describe, it, expect } from 'vitest';
import { VietnameseTTSEngine, generateSyntheticWavBuffer } from '@vietdub/backend';

describe('VietnameseTTSEngine', () => {
  it('should generate valid WAV audio buffer for Vietnamese text', async () => {
    const tts = new VietnameseTTSEngine();
    const res = await tts.synthesize({
      segmentId: 'seg_1',
      text: 'Chúng ta cùng phân tích kỹ hơn nhé.',
      generation: 1,
      startMs: 0,
      endMs: 1500
    });

    expect(res.cancelled).toBe(false);
    expect(res.audioBase64).toBeTruthy();
    expect(res.durationMs).toBeGreaterThan(500);

    const buf = Buffer.from(res.audioBase64, 'base64');
    expect(buf.subarray(0, 4).toString()).toBe('RIFF');
    expect(buf.subarray(8, 12).toString()).toBe('WAVE');
  });

  it('should cancel generation when user seeks or generation is invalidated', async () => {
    const tts = new VietnameseTTSEngine();
    tts.cancelGeneration(1);

    const res = await tts.synthesize({
      segmentId: 'seg_old',
      text: 'Câu này bị hủy khi người dùng tua.',
      generation: 1,
      startMs: 0,
      endMs: 1500
    });

    expect(res.cancelled).toBe(true);
    expect(res.audioBase64).toBe('');
  });

  it('generateSyntheticWavBuffer creates correct WAV header and data size', () => {
    const duration = 1.0;
    const sampleRate = 16000;
    const buf = generateSyntheticWavBuffer(duration, sampleRate);

    expect(buf.length).toBe(44 + sampleRate * 2 * duration);
    expect(buf.readUInt32LE(24)).toBe(sampleRate);
    expect(buf.readUInt16LE(22)).toBe(1); // Mono
    expect(buf.readUInt16LE(34)).toBe(16); // 16-bit
  });
});
