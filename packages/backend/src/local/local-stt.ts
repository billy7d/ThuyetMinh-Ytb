import { LocalWorkerClientLike } from './worker-client.js';
import { STTProvider, STTResult, STTStreamCallbacks, STTStreamSession } from '../stt/types.js';

export interface LocalSTTConfig {
  modelPath: string;
  sampleRate: number;
  channels: number;
  maxPendingChunks: number;
}

export const DEFAULT_LOCAL_STT_CONFIG: LocalSTTConfig = {
  modelPath: '',
  sampleRate: 16_000,
  channels: 1,
  maxPendingChunks: 12
};

interface LocalSTTEvent {
  kind: 'interim' | 'final';
  segmentId?: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

interface LocalSTTResponse {
  events?: LocalSTTEvent[];
}

/**
 * Local STT boundary. The worker owns the model and must implement bounded
 * streaming/utterance assembly; this adapter never sends audio to a network.
 */
export class LocalStreamingSTTProvider implements STTProvider {
  readonly name = 'LocalWhisperCppSTT';
  private readonly config: LocalSTTConfig;

  constructor(
    private readonly worker: LocalWorkerClientLike,
    config: Partial<LocalSTTConfig> = {}
  ) {
    this.config = { ...DEFAULT_LOCAL_STT_CONFIG, ...config };
    if (!this.config.modelPath.trim()) throw new Error('LOCAL_STT_MODEL_PATH is required');
    if (this.config.sampleRate !== 16_000 || this.config.channels !== 1) {
      throw new Error('Local STT requires mono 16 kHz PCM');
    }
    if (this.config.maxPendingChunks < 1) throw new Error('LOCAL_STT_MAX_PENDING_CHUNKS must be positive');
  }

  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    return new LocalSTTStreamSession(sessionId, this.config, this.worker, callbacks);
  }
}

class LocalSTTStreamSession implements STTStreamSession {
  private ended = false;
  private endRequested = false;
  private reportedError = false;
  private pendingChunks = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly startPromise: Promise<void>;

  constructor(
    private readonly sessionId: string,
    private readonly config: LocalSTTConfig,
    private readonly worker: LocalWorkerClientLike,
    private readonly callbacks: STTStreamCallbacks
  ) {
    this.startPromise = this.worker.request<void>({
      op: 'start_stream',
      sessionId,
      modelPath: config.modelPath,
      sampleRate: config.sampleRate,
      channels: config.channels
    }).catch(error => {
      this.reportError(error);
      throw error;
    });
  }

  sendAudioChunk(pcmData: Buffer, timestampMs: number): void {
    if (this.ended || this.endRequested || pcmData.length === 0) return;
    if (pcmData.length % 2 !== 0) {
      this.reportError(new Error('Local STT audio must be 16-bit PCM with an even byte length'));
      return;
    }
    if (this.pendingChunks >= this.config.maxPendingChunks) {
      this.reportError(new Error(`Local STT queue exceeded ${this.config.maxPendingChunks} pending audio chunks`));
      return;
    }

    this.pendingChunks++;
    const request = async (): Promise<void> => {
      await this.startPromise;
      if (this.ended) return;
      const response = await this.worker.request<LocalSTTResponse>({
        op: 'audio_chunk',
        sessionId: this.sessionId,
        pcmBase64: pcmData.toString('base64'),
        timestampMs,
        durationMs: Math.round((pcmData.length / 2 / this.config.sampleRate) * 1000),
        sampleRate: this.config.sampleRate,
        channels: this.config.channels
      });
      if (this.ended) return;
      for (const event of response.events ?? []) this.emitEvent(event);
    };
    this.chain = this.chain
      .then(request)
      .catch(error => this.reportError(error))
      .finally(() => { this.pendingChunks--; });
  }

  endStream(): void {
    if (this.ended || this.endRequested) return;
    this.endRequested = true;
    this.chain = this.chain
      .then(async () => {
        if (this.reportedError) return;
        await this.worker.request<void>({ op: 'end_stream', sessionId: this.sessionId });
      })
      .catch(error => this.reportError(error))
      .finally(() => { this.ended = true; });
  }

  private emitEvent(event: LocalSTTEvent): void {
    if (!event.text?.trim()) return;
    const result: STTResult = {
      segmentId: event.segmentId,
      text: event.text.trim(),
      startMs: Math.max(0, Math.round(event.startMs)),
      endMs: Math.max(0, Math.round(event.endMs)),
      isFinal: event.kind === 'final',
      confidence: typeof event.confidence === 'number' ? event.confidence : 0,
      receivedAtMs: Date.now()
    };
    if (event.kind === 'final') this.callbacks.onFinal(result);
    else this.callbacks.onInterim(result);
  }

  private reportError(error: unknown): void {
    if (this.reportedError) return;
    this.reportedError = true;
    this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
