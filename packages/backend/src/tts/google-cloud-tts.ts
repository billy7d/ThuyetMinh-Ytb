import { TTSProvider, TTSRequest, TTSResponse } from './types.js';

export interface GoogleCloudTTSConfig {
  apiKey?: string;
  accessToken?: string;
  languageCode: string;
  voiceName: string;
  sampleRateHertz: number;
  timeoutMs: number;
  baseUrl: string;
}

export const DEFAULT_GOOGLE_CLOUD_TTS_CONFIG: Omit<GoogleCloudTTSConfig, 'apiKey' | 'accessToken'> = {
  languageCode: 'vi-VN',
  voiceName: 'vi-VN-Standard-A',
  sampleRateHertz: 24000,
  timeoutMs: 15000,
  baseUrl: 'https://texttospeech.googleapis.com/v1'
};

interface GoogleTTSResponse {
  audioContent?: string;
}

/** Google Cloud Text-to-Speech REST adapter using LINEAR16/WAV output. */
export class GoogleCloudTTSProvider implements TTSProvider {
  readonly name = 'GoogleCloudTTS';
  private readonly config: GoogleCloudTTSConfig;
  private activeGeneration = 1;
  private readonly cancelledGenerations = new Set<number>();
  private readonly controllers = new Map<number, AbortController>();

  constructor(config: Partial<GoogleCloudTTSConfig> = {}) {
    this.config = { ...DEFAULT_GOOGLE_CLOUD_TTS_CONFIG, ...config };
    if (!this.config.apiKey && !this.config.accessToken) {
      throw new Error('GOOGLE_CLOUD_TTS_API_KEY or GOOGLE_CLOUD_TTS_ACCESS_TOKEN is required for production TTS');
    }
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    if (this.isCancelled(request.generation)) return this.cancelledResponse(request);

    const controller = new AbortController();
    const existing = this.controllers.get(request.generation);
    existing?.abort();
    this.controllers.set(request.generation, controller);
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const url = new URL(`${this.config.baseUrl}/text:synthesize`);
      if (this.config.apiKey && !this.config.accessToken) url.searchParams.set('key', this.config.apiKey);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.config.accessToken) headers.Authorization = `Bearer ${this.config.accessToken}`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: { text: request.text },
          voice: {
            languageCode: this.config.languageCode,
            name: this.config.voiceName
          },
          audioConfig: {
            audioEncoding: 'LINEAR16',
            sampleRateHertz: this.config.sampleRateHertz,
            speakingRate: 1.0
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Google Cloud TTS failed with HTTP ${response.status}${body ? `: ${this.safeError(body)}` : ''}`);
      }

      const payload = await response.json() as GoogleTTSResponse;
      if (!payload.audioContent) throw new Error('Google Cloud TTS returned no audio content');
      const wav = Buffer.from(payload.audioContent, 'base64');
      const metadata = parseWavMetadata(wav);

      if (this.isCancelled(request.generation)) return this.cancelledResponse(request);
      return {
        segmentId: request.segmentId,
        generation: request.generation,
        audioBase64: wav.toString('base64'),
        mimeType: 'audio/wav',
        durationMs: metadata.durationMs,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        cancelled: false
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && this.isCancelled(request.generation)) {
        return this.cancelledResponse(request);
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Google Cloud TTS timed out after ${this.config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.controllers.get(request.generation) === controller) this.controllers.delete(request.generation);
    }
  }

  setGeneration(generation: number): void {
    this.activeGeneration = generation;
  }

  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation);
    this.controllers.get(generation)?.abort();
  }

  private isCancelled(generation: number): boolean {
    return this.cancelledGenerations.has(generation) || generation < this.activeGeneration;
  }

  private cancelledResponse(request: TTSRequest): TTSResponse {
    return {
      segmentId: request.segmentId,
      generation: request.generation,
      audioBase64: '',
      mimeType: 'audio/wav',
      durationMs: 0,
      sampleRate: this.config.sampleRateHertz,
      channels: 1,
      cancelled: true
    };
  }

  private safeError(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').slice(0, 240);
  }
}

export interface WavMetadata {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  byteRate: number;
  dataBytes: number;
  durationMs: number;
}

export function parseWavMetadata(buffer: Buffer): WavMetadata {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString() !== 'RIFF' || buffer.subarray(8, 12).toString() !== 'WAVE') {
    throw new Error('TTS audio is not a RIFF/WAVE payload');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString();
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkStart + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      byteRate = buffer.readUInt32LE(chunkStart + 8);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataBytes = Math.min(chunkSize, Math.max(0, buffer.length - chunkStart));
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channels || !byteRate || !dataBytes) throw new Error('TTS WAV payload has incomplete metadata');
  return {
    sampleRate,
    channels,
    bitsPerSample,
    byteRate,
    dataBytes,
    durationMs: Math.round((dataBytes / byteRate) * 1000)
  };
}
