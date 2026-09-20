export interface TTSRequest {
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
