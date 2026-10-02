import { describe, expect, it } from 'vitest';
import { AudioMixer } from '../../extension/src/audio/mixer.js';
import { stretchAudioBuffer, timeStretchMono } from '../../extension/src/audio/time-stretch.js';

const SAMPLE_RATE = 48_000;

/** Âm hữu thanh giả lập: nền 140 Hz với vài họa âm, biên độ dao động như nhịp âm tiết. */
function voiced(seconds: number, f0 = 140): Float32Array {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < data.length; index += 1) {
    const t = index / SAMPLE_RATE;
    let value = 0;
    for (let harmonic = 1; harmonic <= 6; harmonic += 1) value += Math.sin(2 * Math.PI * f0 * harmonic * t) / harmonic;
    data[index] = 0.3 * value * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
  }
  return data;
}

/** Ước lượng cao độ bằng tự tương quan trên đoạn giữa tín hiệu. */
function estimatePitch(data: Float32Array): number {
  const start = Math.floor(data.length * 0.3);
  const length = 4_000;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = Math.floor(SAMPLE_RATE / 400); lag <= Math.floor(SAMPLE_RATE / 70); lag += 1) {
    let dot = 0;
    for (let index = 0; index < length; index += 1) dot += data[start + index] * data[start + index + lag];
    if (dot > bestScore) {
      bestScore = dot;
      bestLag = lag;
    }
  }
  return SAMPLE_RATE / bestLag;
}

describe('co giãn thời gian giữ cao độ', () => {
  it('rút ngắn đúng tỉ lệ nhưng giữ cao độ (phát nhanh bằng playbackRate sẽ làm cao độ tăng 1.3 lần)', () => {
    const input = voiced(3);
    const output = timeStretchMono(input, SAMPLE_RATE, 1.3);
    expect(output.length / input.length).toBeCloseTo(1 / 1.3, 2);
    const before = estimatePitch(input);
    const after = estimatePitch(output);
    expect(Math.abs(after - before) / before).toBeLessThan(0.04);
    expect(Math.abs(after - before * 1.3) / (before * 1.3)).toBeGreaterThan(0.2);
  });

  it('giữ mức âm lượng và không tạo giá trị ngoài khoảng', () => {
    const input = voiced(2);
    const output = timeStretchMono(input, SAMPLE_RATE, 1.25);
    const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    expect(rms(output) / rms(input)).toBeGreaterThan(0.85);
    expect(rms(output) / rms(input)).toBeLessThan(1.15);
    expect(Math.max(...output.map(Math.abs))).toBeLessThan(1.2);
  });

  it('rate 1 và đoạn quá ngắn trả về nguyên bản; rate sai báo lỗi', () => {
    const input = voiced(0.5);
    expect(timeStretchMono(input, SAMPLE_RATE, 1)).toEqual(input);
    const tiny = new Float32Array(100).fill(0.1);
    expect(timeStretchMono(tiny, SAMPLE_RATE, 1.3)).toEqual(tiny);
    expect(() => timeStretchMono(input, SAMPLE_RATE, 0)).toThrow();
  });

  it('AudioMixer phát câu cần tăng tốc ở playbackRate 1 với buffer đã co giãn', () => {
    const created: Array<{ length: number }> = [];
    const sources: Array<{ buffer: unknown; playbackRate: { value: number } }> = [];
    const node = () => ({ connect: () => {}, disconnect: () => {}, gain: { setValueAtTime: () => {} } });
    const makeBuffer = (channels: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      created.push({ length });
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (channel: number) => data[channel] } as unknown as AudioBuffer;
    };
    const context = {
      currentTime: 0,
      destination: node(),
      createGain: node,
      createBuffer: makeBuffer,
      createBufferSource: () => {
        const source = { ...node(), buffer: null as unknown, onended: null, playbackRate: { value: 1 }, start: () => {}, stop: () => {} };
        sources.push(source);
        return source;
      }
    } as unknown as AudioContext;
    const mixer = new AudioMixer(context, node() as unknown as MediaStreamAudioSourceNode);
    const input = makeBuffer(1, SAMPLE_RATE * 4, SAMPLE_RATE);
    input.getChannelData(0).set(voiced(4));
    // Câu 4 s cho khung 2.4 s + 0.6 s nghỉ = 3 s: cần tăng tốc 1.3x.
    const scheduled = mixer.scheduleTTSBuffer(input, undefined, 2_400);
    expect(sources[0].playbackRate.value).toBe(1);
    expect(sources[0].buffer).not.toBe(input);
    expect(scheduled?.durationMs).toBeGreaterThan(3_000);
    expect(scheduled?.durationMs).toBeLessThan(3_200);
    expect(stretchAudioBuffer(context, input, 1.3).duration).toBeCloseTo(4 / 1.3, 1);
  });
});
