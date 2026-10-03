/**
 * Co giãn thời gian giữ cao độ theo luồng (cùng thuật toán WSOLA với time-stretch.ts nhưng nhận âm thanh từng đoạn).
 *
 * Giọng đọc dạng luồng đến từng đoạn ~0.5–2 s. Co giãn riêng từng đoạn sẽ để lại "lỗ" âm lượng ở mỗi mối nối (cửa sổ Hann mờ dần ở hai đầu),
 * nên giữ trạng thái giữa các lần gọi: phần chồng lấp của khung cuối đoạn trước được cộng với khung đầu đoạn sau. Kết quả đầu ra giống hệt
 * timeStretchMono() chạy trên cả câu, bất kể đoạn nhỏ hay lớn.
 */

const FRAME_SECONDS = 0.03;
const SEARCH_SECONDS = 0.012;
const SEARCH_DECIMATION = 8;

export class StreamingTimeStretcher {
  private readonly frame: number;
  private readonly hop: number;
  private readonly analysisHop: number;
  private readonly searchSteps: number;
  private readonly compareLength: number;
  private readonly window: Float32Array;
  private readonly acc: Float32Array;
  private input = new Float32Array(1 << 16);
  private dec = new Float32Array((1 << 16) / SEARCH_DECIMATION);
  private inputLength = 0;
  private decLength = 0;
  private frameIndex = 0;
  private previousStart = 0;
  private emitted = 0;

  constructor(sampleRate: number, private readonly rate: number) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Tốc độ co giãn không hợp lệ');
    let frame = Math.max(64, Math.round(FRAME_SECONDS * sampleRate));
    frame += frame % 2;
    this.frame = frame;
    this.hop = frame / 2;
    this.analysisHop = this.hop * rate;
    this.searchSteps = Math.max(1, Math.round((SEARCH_SECONDS * sampleRate) / SEARCH_DECIMATION));
    this.compareLength = Math.max(8, Math.floor(this.hop / SEARCH_DECIMATION));
    this.window = new Float32Array(frame);
    for (let index = 0; index < frame; index += 1) this.window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frame);
    this.acc = new Float32Array(frame);
  }

  /** Đưa thêm một đoạn đầu vào; trả về phần đầu ra đã chốt (có thể rỗng khi chưa đủ dữ liệu cho một khung). */
  push(chunk: Float32Array): Float32Array {
    if (chunk.length === 0) return new Float32Array(0);
    this.ensureCapacity(this.inputLength + chunk.length);
    this.input.set(chunk, this.inputLength);
    this.inputLength += chunk.length;
    const completeBlocks = Math.floor(this.inputLength / SEARCH_DECIMATION);
    this.fillDecimated(completeBlocks);
    return this.process(false);
  }

  /** Hết dữ liệu: xả nốt phần còn lại (cắt đúng độ dài đầu ra = đầu vào / rate). */
  flush(): Float32Array {
    if (this.inputLength === 0) return new Float32Array(0);
    if (this.frameIndex === 0 && this.inputLength < this.frame * 2) {
      // Quá ngắn để co giãn (giống timeStretchMono): trả nguyên bản.
      const copy = this.input.slice(0, this.inputLength);
      this.inputLength = 0;
      return copy;
    }
    return this.process(true);
  }

  private ensureCapacity(length: number): void {
    if (length <= this.input.length) return;
    let capacity = this.input.length;
    while (capacity < length) capacity *= 2;
    const input = new Float32Array(capacity);
    input.set(this.input.subarray(0, this.inputLength));
    this.input = input;
    const dec = new Float32Array(Math.ceil(capacity / SEARCH_DECIMATION) + 1);
    dec.set(this.dec.subarray(0, this.decLength));
    this.dec = dec;
  }

  private fillDecimated(blocks: number): void {
    while (this.decLength < blocks) {
      let sum = 0;
      const base = this.decLength * SEARCH_DECIMATION;
      for (let inner = 0; inner < SEARCH_DECIMATION; inner += 1) sum += this.input[base + inner];
      this.dec[this.decLength] = sum / SEARCH_DECIMATION;
      this.decLength += 1;
    }
  }

  private process(final: boolean): Float32Array {
    const pieces: Float32Array[] = [];
    const target = Math.floor(this.inputLength / this.rate);
    for (;;) {
      const k = this.frameIndex;
      const ideal = Math.round(k * this.analysisHop);
      const needed = k === 0 ? this.frame : ideal + this.searchSteps * SEARCH_DECIMATION + this.frame;
      if (final) {
        if (this.emitted >= target) break;
        // Cuối luồng: phần ngoài dữ liệu thật coi như im lặng.
        this.ensureCapacity(needed + SEARCH_DECIMATION);
        this.fillDecimated(Math.ceil(needed / SEARCH_DECIMATION));
      } else if (this.inputLength < needed) {
        break;
      }

      let start = 0;
      if (k > 0) {
        const idealBase = Math.floor(ideal / SEARCH_DECIMATION);
        const targetBase = Math.floor((this.previousStart + this.hop) / SEARCH_DECIMATION);
        let bestBase = Math.min(Math.max(idealBase, 0), Math.max(0, this.decLength - 1));
        let bestScore = -Infinity;
        for (let step = -this.searchSteps; step <= this.searchSteps; step += 1) {
          const candidate = idealBase + step;
          if (candidate < 0 || candidate + this.compareLength >= this.decLength || targetBase + this.compareLength >= this.decLength) continue;
          let dot = 0;
          let energy = 1e-9;
          for (let index = 0; index < this.compareLength; index += 1) {
            const value = this.dec[candidate + index];
            dot += value * this.dec[targetBase + index];
            energy += value * value;
          }
          const score = dot / Math.sqrt(energy);
          if (score > bestScore) {
            bestScore = score;
            bestBase = candidate;
          }
        }
        start = bestBase * SEARCH_DECIMATION;
      }
      for (let index = 0; index < this.frame; index += 1) this.acc[index] += this.window[index] * this.input[start + index];
      this.previousStart = start;
      this.frameIndex += 1;

      // Nửa đầu của bộ cộng dồn không còn khung nào chồng lên nữa: đã chốt.
      let piece = this.acc.slice(0, this.hop);
      this.acc.copyWithin(0, this.hop);
      this.acc.fill(0, this.hop);
      if (final && this.emitted + piece.length > target) piece = piece.subarray(0, Math.max(0, target - this.emitted));
      this.emitted += piece.length;
      pieces.push(piece);
    }
    return concat(pieces);
  }
}

function concat(pieces: Float32Array[]): Float32Array {
  let length = 0;
  for (const piece of pieces) length += piece.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}
