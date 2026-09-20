import { LocalWorkerClientLike, abortError } from './worker-client.js';
import { TTSProvider, TTSRequest, TTSResponse } from '../tts/types.js';
import { parseWavMetadata } from '../tts/google-cloud-tts.js';

export interface LocalTTSConfig {
  modelPath: string;
  timeoutMs: number;
  maxConcurrentRequests: number;
  sampleRate: number;
}

export const DEFAULT_LOCAL_TTS_CONFIG: LocalTTSConfig = {
  modelPath: '',
  timeoutMs: 30_000,
  maxConcurrentRequests: 2,
  sampleRate: 24_000
};

interface LocalTTSWorkerResponse {
  audioBase64?: string;
  mimeType?: TTSResponse['mimeType'];
  sampleRate?: number;
  channels?: number;
  durationMs?: number;
}

/** Local Vietnamese TTS adapter. Audio metadata is derived from the payload. */
export class LocalVietnameseTTSProvider implements TTSProvider {
  readonly name = 'LocalVietnameseTTS';
  private readonly config: LocalTTSConfig;
  private readonly cancelledGenerations = new Set<number>();
  private readonly controllers = new Map<number, AbortController>();
  private activeGeneration = 1;
  private inFlight = 0;

  constructor(
    private readonly worker: LocalWorkerClientLike,
    config: Partial<LocalTTSConfig> = {}
  ) {
    this.config = { ...DEFAULT_LOCAL_TTS_CONFIG, ...config };
    if (!this.config.modelPath.trim()) throw new Error('LOCAL_TTS_MODEL_PATH is required');
    if (this.config.timeoutMs < 1) throw new Error('LOCAL_TTS_TIMEOUT_MS must be positive');
    if (this.config.maxConcurrentRequests < 1) throw new Error('LOCAL_TTS_MAX_CONCURRENT_REQUESTS must be positive');
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    if (this.isCancelled(request.generation)) return this.cancelledResponse(request);
    if (this.inFlight >= this.config.maxConcurrentRequests) {
      throw new Error(`Local TTS queue exceeded ${this.config.maxConcurrentRequests} concurrent requests`);
    }

    const controller = new AbortController();
    const previous = this.controllers.get(request.generation);
    previous?.abort();
    this.controllers.set(request.generation, controller);
    this.inFlight++;
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.worker.request<LocalTTSWorkerResponse>({
        op: 'synthesize',
        modelPath: this.config.modelPath,
        segmentId: request.segmentId,
        generation: request.generation,
        text: request.text,
        startMs: request.startMs,
        endMs: request.endMs
      }, { signal: controller.signal });

      if (this.isCancelled(request.generation)) return this.cancelledResponse(request);
      const audioBase64 = response.audioBase64?.trim() || '';
      if (!audioBase64) throw new Error('Local TTS worker returned no audio');
      const mimeType = response.mimeType || 'audio/wav';
      if (mimeType !== 'audio/wav') {
        throw new Error(`Local TTS must return audio/wav for browser decode; received ${mimeType}`);
      }
      const audio = Buffer.from(audioBase64, 'base64');
      const metadata = parseWavMetadata(audio);
      return {
        segmentId: request.segmentId,
        generation: request.generation,
        audioBase64,
        mimeType: 'audio/wav',
        durationMs: metadata.durationMs,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        cancelled: false
      };
    } catch (error) {
      if (controller.signal.aborted && this.isCancelled(request.generation)) {
        return this.cancelledResponse(request);
      }
      if (controller.signal.aborted) throw abortError(`Local TTS timed out after ${this.config.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.inFlight--;
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
      sampleRate: this.config.sampleRate,
      channels: 1,
      cancelled: true
    };
  }
}
