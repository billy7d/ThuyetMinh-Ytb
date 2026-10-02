/**
 * Co giãn thời gian giữ nguyên cao độ (WSOLA: overlap-add có cửa sổ, chọn điểm ghép cùng pha nhất).
 *
 * AudioBufferSourceNode.playbackRate đổi cả cao độ: phát nhanh 1.3x làm giọng cao lên ~4.5 nửa cung (nghe như nhân vật hoạt hình).
 * Hàm này rút ngắn thời lượng mà giữ cao độ và âm sắc của giọng đọc. Chỉ dùng cho giọng nói, rate hợp lý trong 0.5–2.
 */

/** Độ dài khung phân tích (giây). 30 ms đủ dài để chứa một chu kỳ cao độ giọng nói, đủ ngắn để không làm nhòe phụ âm. */
const FRAME_SECONDS = 0.03;
/** Biên độ tìm điểm ghép quanh vị trí lý tưởng (giây). */
const SEARCH_SECONDS = 0.012;
/** Tìm điểm ghép trên tín hiệu giảm mẫu để giữ chi phí thấp (~30 ms cho 3 s âm thanh). */
const SEARCH_DECIMATION = 4;

export function timeStretchMono(input: Float32Array, sampleRate: number, rate: number): Float32Array {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Tốc độ co giãn không hợp lệ');
  if (Math.abs(rate - 1) < 0.005) return input.slice();
  let frame = Math.max(64, Math.round(FRAME_SECONDS * sampleRate));
  frame += frame % 2;
  const synthesisHop = frame / 2;
  const analysisHop = synthesisHop * rate;
  const search = Math.max(SEARCH_DECIMATION, Math.round(SEARCH_SECONDS * sampleRate));
  if (input.length < frame * 2) return input.slice();

  const outputLength = Math.floor(input.length / rate);
  const output = new Float32Array(outputLength + frame);
  const window = new Float32Array(frame);
  for (let index = 0; index < frame; index += 1) window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frame);

  const sample = (position: number): number => (position >= 0 && position < input.length ? input[position] : 0);
  let previousStart = 0;
  const frames = Math.ceil(outputLength / synthesisHop);
  for (let k = 0; k < frames; k += 1) {
    const outputStart = k * synthesisHop;
    let start = 0;
    if (k > 0) {
      const ideal = Math.round(k * analysisHop);
      // Đoạn tiếp nối tự nhiên của khung trước: khung mới phải khớp với nó thì mối ghép mới không bị vỡ tiếng.
      const target = previousStart + synthesisHop;
      let best = Math.min(Math.max(ideal, 0), input.length - 1);
      let bestScore = -Infinity;
      for (let offset = -search; offset <= search; offset += SEARCH_DECIMATION) {
        const candidate = ideal + offset;
        if (candidate < 0 || candidate >= input.length) continue;
        let dot = 0;
        let energy = 1e-9;
        for (let index = 0; index < synthesisHop; index += SEARCH_DECIMATION) {
          const value = sample(candidate + index);
          dot += value * sample(target + index);
          energy += value * value;
        }
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      start = best;
      if (start >= input.length) break;
    }
    for (let index = 0; index < frame; index += 1) {
      const position = outputStart + index;
      if (position < output.length) output[position] += window[index] * sample(start + index);
    }
    previousStart = start;
  }
  return output.slice(0, outputLength);
}

/** Co giãn AudioBuffer (mọi kênh dùng chung một rate); trả về buffer mới ngắn hơn khoảng `rate` lần. */
export function stretchAudioBuffer(context: Pick<BaseAudioContext, 'createBuffer'>, buffer: AudioBuffer, rate: number): AudioBuffer {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(timeStretchMono(buffer.getChannelData(channel), buffer.sampleRate, rate));
  }
  const stretched = context.createBuffer(buffer.numberOfChannels, Math.max(1, channels[0].length), buffer.sampleRate);
  channels.forEach((data, channel) => stretched.getChannelData(channel).set(data));
  return stretched;
}
