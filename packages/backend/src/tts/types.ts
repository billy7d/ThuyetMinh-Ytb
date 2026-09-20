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

export interface TTSProvider {
  name: string;
  synthesize(request: TTSRequest): Promise<TTSResponse>;
  cancelGeneration(generation: number): void;
}
