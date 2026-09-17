import { describe, it, expect } from 'vitest';
import { SimpleVAD } from '@vietdub/backend';

describe('SimpleVAD (Voice Activity Detection)', () => {
  it('should detect silence when PCM buffer has zero energy', () => {
    const vad = new SimpleVAD();
    const silentBuffer = Buffer.alloc(3200); // 100ms of silence at 16kHz 16-bit
    const res = vad.process(silentBuffer, 100);
    expect(res.isVoice).toBe(false);
    expect(res.speechStarted).toBe(false);
    expect(res.speechEnded).toBe(false);
  });

  it('should detect voice when PCM buffer has amplitude above threshold', () => {
    const vad = new SimpleVAD();
    const voiceBuffer = Buffer.alloc(3200);
    // Fill with sine wave
    for (let i = 0; i < voiceBuffer.length; i += 2) {
      voiceBuffer.writeInt16LE(Math.floor(Math.sin(i / 10) * 15000), i);
    }
    const res = vad.process(voiceBuffer, 100);
    expect(res.isVoice).toBe(true);
    expect(res.speechStarted).toBe(true);
  });

  it('should trigger speechEnded after sustained speech followed by silence', () => {
    const vad = new SimpleVAD({ silenceDurationMs: 300, minSpeechDurationMs: 200 });
    const voiceBuffer = Buffer.alloc(3200);
    for (let i = 0; i < voiceBuffer.length; i += 2) {
      voiceBuffer.writeInt16LE(Math.floor(Math.sin(i / 10) * 15000), i);
    }
    const silentBuffer = Buffer.alloc(3200);

    // 300ms of voice
    vad.process(voiceBuffer, 100);
    vad.process(voiceBuffer, 200);
    vad.process(voiceBuffer, 300);

    // Followed by 350ms of silence
    vad.process(silentBuffer, 400);
    vad.process(silentBuffer, 500);
    const endCheck = vad.process(silentBuffer, 700);

    expect(endCheck.speechEnded).toBe(true);
    expect(endCheck.startMs).toBe(100);
  });
});
