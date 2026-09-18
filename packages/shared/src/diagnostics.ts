export interface PcmDiagnosticStats {
  sampleCount: number;
  rms: number;
  peak: number;
  nonZeroSamples: number;
}

type DiagnosticScalar = boolean | number | string | null;

const SENSITIVE_FIELD = /^(?:audio|pcm|text|url|title|sourceText|translatedText|audioBase64|pcmBase64|videoUrl|videoTitle|token|prompt|message|secret|apiKey)$/i;

/** Tạo mã tương quan không chứa nguyên văn session ID trong log phát triển. */
export function diagnosticSessionRef(sessionId?: string | null): string {
  if (!sessionId) return 'missing';

  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `s_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sanitizeField(field: string, value: unknown): DiagnosticScalar {
  if (SENSITIVE_FIELD.test(field)) return '[redacted]';
  if (typeof value === 'string') return value.length > 120 ? `len:${value.length}` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return typeof value === 'undefined' ? null : '[redacted]';
}

/** Log cấu trúc an toàn: không ghi nội dung câu, URL, PCM/base64 hoặc token. */
export function emitDiagnostic(
  scope: string,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [field, sanitizeField(field, value)])
  );
  globalThis.console?.debug(`[VIETDUB][DIAG] ${scope}.${event}`, safeFields);
}

/** Tính thống kê PCM 16-bit little-endian mà không lưu hoặc ghi lại mẫu âm thanh. */
export function calculatePcm16Stats(bytes: Uint8Array): PcmDiagnosticStats {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (sampleCount === 0) {
    return { sampleCount: 0, rms: 0, peak: 0, nonZeroSamples: 0 };
  }

  let sumSquares = 0;
  let peak = 0;
  let nonZeroSamples = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = index * 2;
    const unsigned = bytes[offset] | (bytes[offset + 1] << 8);
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    const normalized = signed / 32768;
    const magnitude = Math.abs(normalized);
    sumSquares += normalized * normalized;
    peak = Math.max(peak, magnitude);
    if (signed !== 0) nonZeroSamples += 1;
  }

  return {
    sampleCount,
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
    nonZeroSamples
  };
}

/** Tính RMS cho Float32 PCM trước khi đóng gói sang 16-bit. */
export function calculateFloatPcmStats(samples: ArrayLike<number>): PcmDiagnosticStats {
  if (samples.length === 0) return { sampleCount: 0, rms: 0, peak: 0, nonZeroSamples: 0 };

  let sumSquares = 0;
  let peak = 0;
  let nonZeroSamples = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number(samples[index]) || 0;
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (sample !== 0) nonZeroSamples += 1;
  }

  return {
    sampleCount: samples.length,
    rms: Math.sqrt(sumSquares / samples.length),
    peak,
    nonZeroSamples
  };
}
