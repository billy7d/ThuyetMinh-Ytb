import { WebSocket } from 'ws';
import { STTProvider, STTResult, STTStreamCallbacks, STTStreamSession } from './types.js';

export interface DeepgramSTTConfig {
  apiKey: string;
  model: string;
  language: string;
  sampleRate: number;
  channels: number;
  endpointingMs: number;
  utteranceEndMs: number;
  connectionTimeoutMs: number;
  maxBufferedAudioBytes: number;
  maxReconnectAttempts: number;
}

export const DEFAULT_DEEPGRAM_STT_CONFIG: Omit<DeepgramSTTConfig, 'apiKey'> = {
  model: 'nova-3',
  language: 'en-US',
  sampleRate: 16000,
  channels: 1,
  endpointingMs: 450,
  utteranceEndMs: 1000,
  connectionTimeoutMs: 8000,
  maxBufferedAudioBytes: 2 * 1024 * 1024,
  maxReconnectAttempts: 2
};

interface DeepgramWord {
  start?: number;
  end?: number;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: DeepgramWord[];
    }>;
  };
}

interface FinalPart {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  key: string;
}

/**
 * Deepgram's Nova-3 live endpoint. The browser sends raw, headerless
 * 16-bit little-endian PCM; encoding and sample rate are therefore explicit
 * query parameters. Provider credentials never leave the backend.
 */
export class DeepgramStreamingSTTProvider implements STTProvider {
  readonly name = 'DeepgramStreamingSTT';
  private readonly config: DeepgramSTTConfig;

  constructor(config: Partial<DeepgramSTTConfig> & Pick<DeepgramSTTConfig, 'apiKey'>) {
    this.config = {
      ...DEFAULT_DEEPGRAM_STT_CONFIG,
      ...config,
      apiKey: config.apiKey.trim()
    };
    if (!this.config.apiKey) {
      throw new Error('DEEPGRAM_API_KEY is required for production STT');
    }
  }

  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    return new DeepgramStreamSession(sessionId, this.config, callbacks);
  }
}

class DeepgramStreamSession implements STTStreamSession {
  private socket: WebSocket | null = null;
  private openTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private pendingAudioDurationMs = 0;
  private totalAudioDurationMs = 0;
  private connectionAudioBaseMs = 0;
  private firstVideoTimestampMs: number | null = null;
  private finalParts: FinalPart[] = [];
  private lastInterimKey = '';
  private reconnectAttempts = 0;
  private ended = false;
  private reportedFatalError = false;

  constructor(
    private readonly sessionId: string,
    private readonly config: DeepgramSTTConfig,
    private readonly callbacks: STTStreamCallbacks
  ) {
    this.connect();
  }

  sendAudioChunk(pcmData: Buffer, timestampMs: number): void {
    if (this.ended || pcmData.length === 0) return;
    if (pcmData.length % 2 !== 0) {
      this.fail(new Error('STT audio must be 16-bit PCM with an even byte length'));
      return;
    }

    if (this.firstVideoTimestampMs === null) {
      this.firstVideoTimestampMs = timestampMs;
    }

    const durationMs = (pcmData.length / 2 / this.config.sampleRate) * 1000;
    this.totalAudioDurationMs += durationMs;

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.pendingAudioBytes + pcmData.length > this.config.maxBufferedAudioBytes) {
        this.fail(new Error(`STT audio buffer exceeded ${this.config.maxBufferedAudioBytes} bytes`));
        return;
      }
      this.pendingAudio.push(pcmData);
      this.pendingAudioBytes += pcmData.length;
      this.pendingAudioDurationMs += durationMs;
      return;
    }

    this.socket.send(pcmData);
  }

  endStream(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
    this.pendingAudioDurationMs = 0;

    if (this.socket) {
      try {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.socket.close(1000, 'session stopped');
      } catch {
        // Cleanup must remain best-effort when the provider has already closed.
      }
      this.socket = null;
    }
  }

  private connect(): void {
    if (this.ended) return;

    const params = new URLSearchParams({
      model: this.config.model,
      language: this.config.language,
      encoding: 'linear16',
      channels: String(this.config.channels),
      sample_rate: String(this.config.sampleRate),
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(this.config.endpointingMs),
      utterance_end_ms: String(this.config.utteranceEndMs),
      vad_events: 'true'
    });

    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: {
        Authorization: `Token ${this.config.apiKey}`
      },
      perMessageDeflate: false
    });
    this.socket = socket;
    this.connectionAudioBaseMs = this.totalAudioDurationMs - this.pendingAudioDurationMs;

    this.openTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.terminate();
        this.fail(new Error(`Deepgram connection timed out for session ${this.sessionId}`));
      }
    }, this.config.connectionTimeoutMs);

    socket.on('open', () => {
      this.clearOpenTimer();
      this.reconnectAttempts = 0;
      this.flushPendingAudio();
    });

    socket.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data.toString());
    });

    socket.on('error', (error: Error) => {
      if (!this.ended) this.callbacks.onError(new Error(`Deepgram STT error: ${error.message}`));
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.clearOpenTimer();
      if (this.ended) return;
      this.socket = null;
      this.finalParts.length = 0;

      if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
        const attempt = ++this.reconnectAttempts;
        const delayMs = Math.min(4000, 250 * 2 ** (attempt - 1));
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delayMs);
        this.callbacks.onError(new Error(`Deepgram STT disconnected (${code}); reconnecting once (${attempt})`));
        return;
      }

      const reasonText = reason?.toString() || 'no reason';
      this.fail(new Error(`Deepgram STT disconnected (${code}): ${reasonText}`));
    });
  }

  private flushPendingAudio(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.pendingAudio.length > 0) {
      const chunk = this.pendingAudio.shift();
      if (!chunk) continue;
      this.socket.send(chunk);
    }
    this.pendingAudioBytes = 0;
    this.pendingAudioDurationMs = 0;
  }

  private handleMessage(raw: string): void {
    let message: DeepgramMessage;
    try {
      message = JSON.parse(raw) as DeepgramMessage;
    } catch {
      return;
    }

    if (message.type === 'UtteranceEnd') {
      this.emitFinalParts();
      return;
    }
    if (message.type !== 'Results') return;

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim() || '';
    if (!text) return;

    const startMs = this.mapProviderTimeMs(message.start ?? 0);
    const durationMs = Math.max(0, Math.round((message.duration ?? 0) * 1000));
    const endMs = Math.max(startMs, startMs + durationMs);
    const confidence = alternative?.confidence ?? 0;
    const receivedAtMs = Date.now();

    if (!message.is_final) {
      const interimKey = `${startMs}:${endMs}:${text}`;
      if (interimKey === this.lastInterimKey) return;
      this.lastInterimKey = interimKey;
      this.callbacks.onInterim({
        text,
        startMs,
        endMs,
        isFinal: false,
        confidence,
        receivedAtMs
      });
      return;
    }

    const key = `${startMs}:${endMs}:${text}`;
    this.finalParts.push({ text, startMs, endMs, confidence, key });
    this.lastInterimKey = '';
    if (message.speech_final) this.emitFinalParts();
  }

  private emitFinalParts(): void {
    if (this.finalParts.length === 0) return;
    const parts = this.finalParts;
    this.finalParts = [];

    const unique = parts.filter((part, index) => parts.findIndex(candidate => candidate.key === part.key) === index);
    const text = this.mergeText(unique.map(part => part.text));
    if (!text) return;

    const startMs = Math.min(...unique.map(part => part.startMs));
    const endMs = Math.max(...unique.map(part => part.endMs));
    const confidence = unique.reduce((sum, part) => sum + part.confidence, 0) / unique.length;
    const segmentId = `dg_${startMs}_${endMs}_${this.hashText(text)}`;
    const result: STTResult = {
      segmentId,
      text,
      startMs,
      endMs,
      isFinal: true,
      confidence,
      receivedAtMs: Date.now()
    };
    this.callbacks.onFinal(result);
  }

  private mapProviderTimeMs(providerStartSeconds: number): number {
    const baseMs = this.firstVideoTimestampMs ?? 0;
    return Math.round(baseMs + this.connectionAudioBaseMs + providerStartSeconds * 1000);
  }

  private mergeText(parts: string[]): string {
    let merged = '';
    for (const part of parts) {
      const text = part.trim();
      if (!text) continue;
      if (!merged) {
        merged = text;
        continue;
      }
      const mergedWords = merged.split(/\s+/);
      const words = text.split(/\s+/);
      let overlap = 0;
      const maxOverlap = Math.min(mergedWords.length, words.length);
      for (let count = maxOverlap; count > 0; count--) {
        const left = mergedWords.slice(-count).join(' ').toLowerCase();
        const right = words.slice(0, count).join(' ').toLowerCase();
        if (left === right) {
          overlap = count;
          break;
        }
      }
      merged = `${merged} ${words.slice(overlap).join(' ')}`.trim();
    }
    return merged;
  }

  private hashText(text: string): string {
    let hash = 0;
    for (let index = 0; index < text.length; index++) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16);
  }

  private fail(error: Error): void {
    if (this.reportedFatalError || this.ended) return;
    this.reportedFatalError = true;
    this.ended = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.terminate();
    } catch {
      // Provider cleanup is best-effort after a fatal connection error.
    }
    this.callbacks.onError(error);
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearOpenTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
