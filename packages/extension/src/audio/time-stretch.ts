/**
 * Co giãn thời gian giữ nguyên cao độ (WSOLA: overlap-add có cửa sổ, chọn điểm ghép cùng pha nhất).
 *
 * AudioBufferSourceNode.playbackRate đổi cả cao độ: phát nhanh 1.3x làm giọng cao lên ~4.5 nửa cung (nghe như nhân vật hoạt hình).
 * Hàm này rút ngắn thời lượng mà giữ cao độ và âm sắc của giọng đọc. Chỉ dùng cho giọng nói, rate hợp lý trong 0.5–2.
 *
 * Chạy trên luồng chính của trang nên phải rẻ và có trần thời gian: bản đầu truy cập trực tiếp mảng từ getChannelData() và tìm điểm ghép
 * trên tín hiệu gốc; trong content script của Firefox mảng đó bị bọc (Xray) nên mỗi lần truy cập chậm hàng chục lần, luồng chính treo
 * cả chục giây và audio gửi lên backend bị dồn cục (vượt giới hạn tốc độ làm phiên dừng).
 */

/** Độ dài khung phân tích (giây). 30 ms đủ dài để chứa một chu kỳ cao độ giọng nói, đủ ngắn để không làm nhòe phụ âm. */
const FRAME_SECONDS = 0.03;
/** Biên độ tìm điểm ghép quanh vị trí lý tưởng (giây). */
const SEARCH_SECONDS = 0.012;
/** Tìm điểm ghép trên tín hiệu giảm mẫu (trung bình mỗi nhóm) để giữ chi phí rất thấp: giọng nói ≥ 70 Hz vẫn còn ≥ 8 mẫu/chu kỳ ở 48 kHz/8. */
const SEARCH_DECIMATION = 8;
/** Quá thời gian này thì bỏ cuộc để mixer lùi về playbackRate, không treo trang. */
export const DEFAULT_STRETCH_BUDGET_MS = 250;

export class StretchBudgetExceededError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`Co giãn thời gian vượt ${Math.round(elapsedMs)} ms`);
    this.name = 'StretchBudgetExceededError';
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function timeStretchMono(input: Float32Array, sampleRate: number, rate: number, budgetMs = DEFAULT_STRETCH_BUDGET_MS): Float32Array {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Tốc độ co giãn không hợp lệ');
  if (Math.abs(rate - 1) < 0.005) return input.slice();
  let frame = Math.max(64, Math.round(FRAME_SECONDS * sampleRate));
  frame += frame % 2;
  const synthesisHop = frame / 2;
  const analysisHop = synthesisHop * rate;
  if (input.length < frame * 2) return input.slice();
  const startedAt = now();

  const decimation = SEARCH_DECIMATION;
  const searchSteps = Math.max(1, Math.round((SEARCH_SECONDS * sampleRate) / decimation));
  const compareLength = Math.max(8, Math.floor(synthesisHop / decimation));
  // Bản giảm mẫu (trung bình mỗi nhóm) tính một lần; vòng lặp tìm kiếm chỉ đọc mảng cục bộ này.
  const decimatedLength = Math.floor(input.length / decimation);
  const decimated = new Float32Array(decimatedLength);
  for (let index = 0; index < decimatedLength; index += 1) {
    let sum = 0;
    const base = index * decimation;
    for (let inner = 0; inner < decimation; inner += 1) sum += input[base + inner];
    decimated[index] = sum / decimation;
  }

  const outputLength = Math.floor(input.length / rate);
  const output = new Float32Array(outputLength + frame);
  const window = new Float32Array(frame);
  for (let index = 0; index < frame; index += 1) window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frame);

  let previousStart = 0;
  const frames = Math.ceil(outputLength / synthesisHop);
  for (let k = 0; k < frames; k += 1) {
    if ((k & 31) === 31) {
      const elapsed = now() - startedAt;
      if (elapsed > budgetMs) throw new StretchBudgetExceededError(elapsed);
    }
    const outputStart = k * synthesisHop;
    let start = 0;
    if (k > 0) {
      const ideal = Math.round(k * analysisHop);
      // Đoạn tiếp nối tự nhiên của khung trước: khung mới phải khớp với nó thì mối ghép mới không bị vỡ tiếng.
      const targetBase = Math.floor((previousStart + synthesisHop) / decimation);
      const idealBase = Math.floor(ideal / decimation);
      let bestBase = Math.min(Math.max(idealBase, 0), decimatedLength - 1);
      let bestScore = -Infinity;
      for (let step = -searchSteps; step <= searchSteps; step += 1) {
        const candidate = idealBase + step;
        if (candidate < 0 || candidate + compareLength >= decimatedLength || targetBase + compareLength >= decimatedLength) continue;
        let dot = 0;
        let energy = 1e-9;
        for (let index = 0; index < compareLength; index += 1) {
          const value = decimated[candidate + index];
          dot += value * decimated[targetBase + index];
          energy += value * value;
        }
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) {
          bestScore = score;
          bestBase = candidate;
        }
      }
      start = bestBase * decimation;
      if (start >= input.length) break;
    }
    const available = Math.min(frame, input.length - start, output.length - outputStart);
    for (let index = 0; index < available; index += 1) output[outputStart + index] += window[index] * input[start + index];
    previousStart = start;
  }
  return output.slice(0, outputLength);
}

/** Sao chép một kênh vào mảng thuộc về script này bằng thao tác gốc (nhanh, không đi qua wrapper Xray). */
function readChannel(buffer: AudioBuffer, channel: number): Float32Array {
  const copy = new Float32Array(buffer.length);
  if (typeof buffer.copyFromChannel === 'function') buffer.copyFromChannel(copy, channel);
  else copy.set(buffer.getChannelData(channel));
  return copy;
}

/** Co giãn AudioBuffer (mọi kênh dùng chung một rate); trả về buffer mới ngắn hơn khoảng `rate` lần. Ném lỗi nếu quá trần thời gian. */
export function stretchAudioBuffer(
  context: Pick<BaseAudioContext, 'createBuffer'>,
  buffer: AudioBuffer,
  rate: number,
  budgetMs = DEFAULT_STRETCH_BUDGET_MS
): AudioBuffer {
  const startedAt = now();
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const remaining = Math.max(1, budgetMs - (now() - startedAt));
    channels.push(timeStretchMono(readChannel(buffer, channel), buffer.sampleRate, rate, remaining));
  }
  const stretched = context.createBuffer(buffer.numberOfChannels, Math.max(1, channels[0].length), buffer.sampleRate);
  channels.forEach((data, channel) => {
    if (typeof stretched.copyToChannel === 'function') stretched.copyToChannel(data as Float32Array<ArrayBuffer>, channel);
    else stretched.getChannelData(channel).set(data);
  });
  return stretched;
}
