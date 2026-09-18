import { describe, expect, it, vi } from 'vitest';
import { MockSTTProvider, SimpleVAD } from '@vietdub/backend';

function voiceBuffer(): Buffer {
  const buffer = Buffer.alloc(3200);
  for (let index = 0; index < buffer.length; index += 2) {
    buffer.writeInt16LE(Math.floor(Math.sin(index / 10) * 15000), index);
  }
  return buffer;
}

describe('MockSTTProvider runtime VAD contract', () => {
  it('chỉ gọi VAD một lần cho mỗi PCM chunk và vẫn chốt transcript', () => {
    const vadProcess = vi.spyOn(SimpleVAD.prototype, 'process');
    const onFinal = vi.fn();
    const provider = new MockSTTProvider(["Let's break it down."]);
    const stream = provider.createStream('mock_vad_regression', {
      onInterim: vi.fn(),
      onFinal,
      onError: vi.fn()
    });

    const voice = voiceBuffer();
    const silence = Buffer.alloc(3200);
    const chunks = [
      [voice, 0],
      [voice, 100],
      [voice, 200],
      [voice, 300],
      [silence, 400],
      [silence, 700],
      [silence, 1000]
    ] as const;
    for (const [pcm, timestampMs] of chunks) stream.sendAudioChunk(pcm, timestampMs);

    expect(vadProcess).toHaveBeenCalledTimes(chunks.length);
    expect(onFinal).toHaveBeenCalledTimes(1);
    vadProcess.mockRestore();
  });

  it('chốt nhiều đoạn mock khi tín hiệu voice liên tục và reset đúng state VAD', () => {
    const onFinal = vi.fn();
    const provider = new MockSTTProvider(["Let's break it down."]);
    const stream = provider.createStream('mock_continuous_voice', {
      onInterim: vi.fn(),
      onFinal,
      onError: vi.fn()
    });

    const voice = voiceBuffer();
    for (let index = 0; index < 20; index += 1) {
      stream.sendAudioChunk(voice, index * 250);
    }

    // Không chờ silence; mỗi segment tối đa 1.5 giây phải tạo một final riêng.
    expect(onFinal).toHaveBeenCalledTimes(2);
  });
});
