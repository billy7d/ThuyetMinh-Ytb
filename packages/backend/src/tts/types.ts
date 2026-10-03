export interface TTSRequest {
  /** Session ID dùng để liên kết log runtime mà không ghi nội dung nhạy cảm. */
  sessionId?: string;
  segmentId: string;
  text: string;
  generation: number;
  startMs: number;
  endMs: number;
}

export interface TTSResponse {
  segmentId: string;
  generation: number;
  audioBase64: string;
  mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/ogg' | 'audio/pcm';
  durationMs: number;
  sampleRate: number;
  channels: number;
  cancelled: boolean;
}

/** Một đoạn âm thanh PCM 16-bit little-endian (mono) của câu đang được tổng hợp dạng luồng. */
export interface TTSStreamPart {
  audioBase64: string;
  mimeType: 'audio/pcm';
  sampleRate: number;
  channels: number;
  durationMs: number;
  index: number;
}

export interface TTSStreamResult {
  cancelled: boolean;
  durationMs: number;
}

export interface TTSProvider {
  name: string;
  synthesize(request: TTSRequest): Promise<TTSResponse>;
  cancelGeneration(generation: number): void;
  /** Số câu có thể tổng hợp song song (mặc định 1). */
  readonly concurrency?: number;
  /** Tổng hợp dạng luồng: gọi onPart cho từng đoạn ngay khi sinh ra. Không có thì pipeline dùng synthesize(). */
  synthesizeStream?(request: TTSRequest, onPart: (part: TTSStreamPart) => void): Promise<TTSStreamResult>;
}
