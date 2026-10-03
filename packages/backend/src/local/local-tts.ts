import { randomUUID } from 'node:crypto';
import { LocalWorkerClientLike, abortError } from './worker-client.js';
import { TTSProvider, TTSRequest, TTSResponse, TTSStreamPart, TTSStreamResult } from '../tts/types.js';
import { parseWavMetadata } from '../tts/google-cloud-tts.js';

export interface LocalTTSConfig {
  modelPath: string;
  timeoutMs: number;
  maxConcurrentRequests: number;
  sampleRate: number;
}

export const DEFAULT_LOCAL_TTS_CONFIG: LocalTTSConfig = {
  modelPath: '',
  timeoutMs: 90_000,
  maxConcurrentRequests: 1,
  // VieNeu v3 Turbo xuất WAV mono 48 kHz.
  sampleRate: 48_000
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
  // Khóa riêng của adapter (một adapter cho mỗi phiên) để worker hủy đúng generation của phiên này.
  private readonly instanceKey = `tts:${randomUUID()}`;
  private readonly cancelledGenerations = new Set<number>();
  private readonly controllers = new Map<number, Set<AbortController>>();
  private readonly waiters: Array<() => void> = [];
  private activeGeneration = 1;
  /** Số tiến trình worker thực sự; giới hạn số câu tổng hợp song song, vì nhiều request vào một tiến trình chỉ xếp hàng. */
  private readonly workerProcesses: number;
  private inFlight = 0;

  constructor(
    private readonly worker: LocalWorkerClientLike,
    config: Partial<LocalTTSConfig> = {},
    workerProcesses = 1
  ) {
    this.workerProcesses = Math.max(1, Math.floor(workerProcesses));
    this.config = { ...DEFAULT_LOCAL_TTS_CONFIG, ...config };
    if (!this.config.modelPath.trim()) throw new Error('LOCAL_TTS_MODEL_PATH is required');
    if (this.config.timeoutMs < 1) throw new Error('LOCAL_TTS_TIMEOUT_MS must be positive');
    if (this.config.maxConcurrentRequests < 1) throw new Error('LOCAL_TTS_MAX_CONCURRENT_REQUESTS must be positive');
  }

  get concurrency(): number {
    return Math.min(this.config.maxConcurrentRequests, this.workerProcesses);
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    if (this.isCancelled(request.generation)) return this.cancelledResponse(request);

    const controller = new AbortController();
    const generationControllers = this.controllers.get(request.generation) ?? new Set<AbortController>();
    generationControllers.add(controller);
    this.controllers.set(request.generation, generationControllers);
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let acquired = false;

    try {
      // Chờ lượt thay vì ném lỗi khi bận: lỗi "queue exceeded" trước đây làm extension dừng cả phiên.
      await this.acquire(controller.signal);
      acquired = true;
      if (this.isCancelled(request.generation)) return this.cancelledResponse(request);

      const response = await this.worker.request<LocalTTSWorkerResponse>({
        op: 'synthesize',
        modelPath: this.config.modelPath,
        sessionId: this.instanceKey,
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
      if (this.isCancelled(request.generation)) return this.cancelledResponse(request);
      if (controller.signal.aborted) throw abortError(`Local TTS timed out after ${this.config.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (acquired) this.release();
      generationControllers.delete(controller);
      if (generationControllers.size === 0 && this.controllers.get(request.generation) === generationControllers) {
        this.controllers.delete(request.generation);
      }
    }
  }

  /**
   * Tổng hợp dạng luồng: worker gửi từng đoạn PCM ngay khi sinh ra nên có tiếng đầu tiên sau ~0.5 s thay vì đợi cả câu
   * (đo: câu 9 s giọng 5.3 s -> 0.54 s). Lệnh hủy dừng được việc sinh âm thanh giữa chừng.
   */
  async synthesizeStream(request: TTSRequest, onPart: (part: TTSStreamPart) => void): Promise<TTSStreamResult> {
    if (this.isCancelled(request.generation)) return { cancelled: true, durationMs: 0 };

    const controller = new AbortController();
    const generationControllers = this.controllers.get(request.generation) ?? new Set<AbortController>();
    generationControllers.add(controller);
    this.controllers.set(request.generation, generationControllers);
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let acquired = false;
    try {
      await this.acquire(controller.signal);
      acquired = true;
      if (this.isCancelled(request.generation)) return { cancelled: true, durationMs: 0 };
      const result = await this.worker.request<{ durationMs?: number }>({
        op: 'synthesize',
        stream: true,
        modelPath: this.config.modelPath,
        sessionId: this.instanceKey,
        segmentId: request.segmentId,
        generation: request.generation,
        text: request.text,
        startMs: request.startMs,
        endMs: request.endMs
      }, {
        signal: controller.signal,
        onPartial: value => {
          if (this.isCancelled(request.generation)) return;
          const part = value as Partial<TTSStreamPart> | null;
          if (!part?.audioBase64 || part.mimeType !== 'audio/pcm') return;
          onPart({
            audioBase64: part.audioBase64,
            mimeType: 'audio/pcm',
            sampleRate: part.sampleRate || this.config.sampleRate,
            channels: part.channels || 1,
            durationMs: part.durationMs || 0,
            index: part.index ?? 0
          });
        }
      });
      if (this.isCancelled(request.generation)) return { cancelled: true, durationMs: 0 };
      return { cancelled: false, durationMs: result?.durationMs ?? 0 };
    } catch (error) {
      if (this.isCancelled(request.generation)) return { cancelled: true, durationMs: 0 };
      if (controller.signal.aborted) throw abortError(`Local TTS timed out after ${this.config.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (acquired) this.release();
      generationControllers.delete(controller);
      if (generationControllers.size === 0 && this.controllers.get(request.generation) === generationControllers) {
        this.controllers.delete(request.generation);
      }
    }
  }

  setGeneration(generation: number): void {
    this.activeGeneration = Math.max(this.activeGeneration, generation);
  }

  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation);
    this.activeGeneration = Math.max(this.activeGeneration, generation + 1);
    for (const controller of this.controllers.get(generation) ?? []) controller.abort();
    // Báo worker bỏ các request của generation cũ còn trong hàng đợi stdin.
    void this.worker.request(
      { op: 'cancel', sessionId: this.instanceKey, beforeGeneration: generation + 1 },
      { bypassQueueLimit: true, timeoutMs: 5_000 }
    ).catch(() => {});
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.inFlight < this.config.maxConcurrentRequests) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError('Local TTS request was cancelled while waiting'));
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.inFlight++;
        resolve();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    next?.();
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
