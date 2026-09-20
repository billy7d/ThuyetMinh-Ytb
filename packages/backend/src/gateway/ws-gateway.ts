import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage,
  ServerMessage,
  SessionReadyMessage,
  SessionMetricsMessage,
  DEFAULT_MODE,
  calculatePcm16Stats,
  diagnosticSessionRef,
  emitDiagnostic
} from '@vietdub/shared';
import { RealtimePipeline } from '../pipeline/realtime-pipeline.js';
import { createProductionProviderFactory, ProductionProviderFactory } from '../provider-factory.js';

const MAX_SESSION_ID_LENGTH = 128;
const MAX_PCM_FRAME_BYTES = 192 * 1024;

interface ActiveSession {
  pipeline: RealtimePipeline;
  ws: WebSocket;
}
export class WebSocketGateway {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly providerFactory: ProductionProviderFactory;
  private readonly maxConcurrentSessions: number;

  constructor(
    private readonly wss: WebSocketServer,
    options: {
      providerFactory?: ProductionProviderFactory;
      maxConcurrentSessions?: number;
    } = {}
  ) {
    this.providerFactory = options.providerFactory || createProductionProviderFactory();
    this.maxConcurrentSessions = options.maxConcurrentSessions || 4;
    this.setupConnectionHandler();
    void this.providerFactory.warmup?.().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[VietDub] Local runtime warmup unavailable: ${message.slice(0, 240)}`);
    });
  }

  getProviderStatus(): ReturnType<ProductionProviderFactory['getStatus']> {
    const status = this.providerFactory.getStatus?.();
    if (status) return status;
    return {
      mode: this.providerFactory.mode,
      configured: this.providerFactory.missingConfiguration.length === 0,
      missingConfiguration: [...this.providerFactory.missingConfiguration]
    };
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      let ownedSessionId: string | null = null;

      ws.on('message', (rawData: Buffer | string) => {
        try {
          const msg = JSON.parse(rawData.toString()) as ClientMessage;
          const validationError = validateClientMessage(msg);
          if (validationError) {
            this.sendError(ws, typeof msg.sessionId === 'string' ? msg.sessionId : 'unknown', 'INVALID_MESSAGE', validationError, false);
            return;
          }
          if (msg.type !== 'SESSION_START' && (!ownedSessionId || msg.sessionId !== ownedSessionId)) {
            this.sendError(ws, msg.sessionId, 'SESSION_OWNERSHIP_ERROR', 'Phiên không thuộc kết nối này.', false);
            return;
          }
          this.handleClientMessage(ws, msg);
          if (msg.type === 'SESSION_START' && this.activeSessions.get(msg.sessionId)?.ws === ws) {
            ownedSessionId = msg.sessionId;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid message';
          this.sendSafe(ws, {
            type: 'ERROR',
            sessionId: ownedSessionId || 'unknown',
            timestamp: Date.now(),
            code: 'INVALID_MESSAGE',
            message,
            fatal: false
          });
        }
      });

      ws.on('close', () => {
        if (ownedSessionId) this.terminateSession(ownedSessionId, ws);
      });

      ws.on('error', () => {
        if (ownedSessionId) this.terminateSession(ownedSessionId, ws);
      });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'SESSION_START': {
        const existing = this.activeSessions.get(msg.sessionId);
        if (existing && existing.ws !== ws) {
          this.sendError(ws, msg.sessionId, 'SESSION_OWNERSHIP_ERROR', 'Session ID đang được sử dụng bởi kết nối khác.', true);
          return;
        }
        if (existing) this.terminateSession(msg.sessionId, ws);
        const sessionRef = diagnosticSessionRef(msg.sessionId);
        emitDiagnostic('gateway', 'session_start_received', {
          sessionRef,
          mode: msg.mode || DEFAULT_MODE,
          audioSampleRate: msg.audioSampleRate,
          hasVideoMetadata: Boolean(msg.videoUrl || msg.videoTitle)
        });
        if (this.activeSessions.size >= this.maxConcurrentSessions) {
          this.sendError(ws, msg.sessionId, 'CONCURRENT_SESSION_LIMIT', 'Số phiên đang hoạt động đã đạt giới hạn.', true);
          return;
        }
        if (msg.audioSampleRate !== 16000) {
          this.sendError(ws, msg.sessionId, 'UNSUPPORTED_AUDIO_FORMAT', 'Backend yêu cầu PCM mono 16 kHz.', true);
          return;
        }

        let dependencies;
        try {
          dependencies = this.providerFactory.create();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Production provider configuration is missing';
          this.sendError(ws, msg.sessionId, 'PROVIDER_NOT_CONFIGURED', message, true);
          return;
        }

        const pipeline = new RealtimePipeline(
          msg.sessionId,
          msg.mode || DEFAULT_MODE,
          dependencies.sttProvider,
          dependencies.translationEngine,
          dependencies.ttsProvider,
          { sendMessage: serverMsg => this.sendSafe(ws, serverMsg) },
          dependencies.budgetConfig
        );
        this.activeSessions.set(msg.sessionId, { pipeline, ws });
        pipeline.start();
        const providers = pipeline.getProviderNames();
        const ready: SessionReadyMessage = {
          type: 'SESSION_READY',
          sessionId: msg.sessionId,
          timestamp: Date.now(),
          sessionConfig: {
            audioSampleRate: msg.audioSampleRate,
            chunkDurationMs: 250,
            sttProvider: providers.stt,
            translationProvider: providers.translation,
            ttsProvider: providers.tts
          }
        };
        this.sendSafe(ws, ready);
        emitDiagnostic('gateway', 'session_ready_emitted', {
          sessionRef,
          audioSampleRate: ready.sessionConfig.audioSampleRate,
          chunkDurationMs: ready.sessionConfig.chunkDurationMs
        });
        break;
      }

      case 'AUDIO_CHUNK': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session?.ws === ws) {
          const pcmBuffer = Buffer.from(msg.pcmBase64, 'base64');
          const stats = calculatePcm16Stats(pcmBuffer);
          emitDiagnostic('gateway', 'audio_chunk_received', {
            sessionRef: diagnosticSessionRef(msg.sessionId),
            sequence: msg.sequence,
            videoTimeMs: msg.videoTimeMs,
            pcmBytes: pcmBuffer.length,
            sampleCount: stats.sampleCount,
            rms: Math.round(stats.rms * 10000) / 10000,
            peak: Math.round(stats.peak * 10000) / 10000,
            nonZeroSamples: stats.nonZeroSamples
          });
          session.pipeline.handleAudioChunk(pcmBuffer, msg.videoTimeMs);
        } else {
          emitDiagnostic('gateway', 'audio_chunk_ignored', {
            sessionRef: diagnosticSessionRef(msg.sessionId),
            sequence: msg.sequence,
            hasSession: false
          });
        }
        break;
      }

      case 'SEEK_EVENT': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session?.ws === ws) session.pipeline.handleSeek(msg.fromMs, msg.toMs);
        break;
      }

      case 'MODE_CHANGE': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session?.ws === ws) session.pipeline.setMode(msg.mode);
        break;
      }

      case 'VIDEO_STATE_UPDATE':
        // State is deliberately not persisted as transcript data. The browser
        // uses it to keep playback/audio queues synchronized locally.
        break;

      case 'SESSION_STOP': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session?.ws !== ws) break;
        const metrics: SessionMetricsMessage = {
          type: 'SESSION_METRICS',
          sessionId: msg.sessionId,
          timestamp: Date.now(),
          metrics: session.pipeline.getCostTracker().getMetrics()
        };
        emitDiagnostic('gateway', 'session_stop_received', {
          sessionRef: diagnosticSessionRef(msg.sessionId),
          reasonLength: msg.reason?.length || 0
        });
        this.sendSafe(ws, metrics);
        this.terminateSession(msg.sessionId, ws);
        break;
      }
    }
  }

  private sendError(ws: WebSocket, sessionId: string, code: string, message: string, fatal: boolean): void {
    this.sendSafe(ws, { type: 'ERROR', sessionId, timestamp: Date.now(), code, message, fatal });
  }

  private sendSafe(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  terminateSession(sessionId: string, expectedWs?: WebSocket): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || (expectedWs && session.ws !== expectedWs)) return;
    session.pipeline.stop();
    this.activeSessions.delete(sessionId);
  }

  close(): void {
    for (const [sessionId, session] of this.activeSessions) {
      session.pipeline.stop();
      this.activeSessions.delete(sessionId);
    }
    this.wss.close();
    void this.providerFactory.close?.();
  }
}

function validateClientMessage(msg: ClientMessage): string | null {
  if (!msg || typeof msg !== 'object') return 'Message phải là một object JSON.';
  if (![
    'SESSION_START',
    'AUDIO_CHUNK',
    'SEEK_EVENT',
    'MODE_CHANGE',
    'VIDEO_STATE_UPDATE',
    'SESSION_STOP'
  ].includes(msg.type)) return 'type không được hỗ trợ.';
  if (!isSafeSessionId(msg.sessionId)) return 'sessionId không hợp lệ.';
  if (!Number.isFinite(msg.timestamp)) return 'timestamp không hợp lệ.';

  if (msg.type === 'SESSION_START') {
    if (!['subtitle_only', 'dubbing_only', 'dubbing_and_subtitle'].includes(msg.mode)) return 'mode không hợp lệ.';
    if (msg.audioSampleRate !== 16_000) return 'Backend yêu cầu PCM mono 16 kHz.';
  }
  if (msg.type === 'AUDIO_CHUNK') {
    if (!Number.isSafeInteger(msg.sequence) || msg.sequence < 0) return 'sequence không hợp lệ.';
    if (!Number.isFinite(msg.videoTimeMs) || msg.videoTimeMs < 0) return 'videoTimeMs không hợp lệ.';
    if (typeof msg.pcmBase64 !== 'string' || msg.pcmBase64.length === 0) return 'pcmBase64 bị thiếu.';
    if (msg.pcmBase64.length > MAX_PCM_FRAME_BYTES * 2) return 'Khung PCM vượt giới hạn.';
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(msg.pcmBase64)) return 'pcmBase64 không hợp lệ.';
    const pcmBuffer = Buffer.from(msg.pcmBase64, 'base64');
    if (pcmBuffer.length === 0 || pcmBuffer.length > MAX_PCM_FRAME_BYTES || pcmBuffer.length % 2 !== 0) {
      return 'Khung PCM phải là 16-bit và không vượt quá giới hạn.';
    }
  }
  if (msg.type === 'SEEK_EVENT') {
    if (![msg.fromMs, msg.toMs, msg.generation].every(Number.isFinite)) return 'Thông tin seek không hợp lệ.';
    if (msg.fromMs < 0 || msg.toMs < 0 || msg.generation < 0) return 'Thông tin seek không hợp lệ.';
  }
  if (msg.type === 'MODE_CHANGE' && !['subtitle_only', 'dubbing_only', 'dubbing_and_subtitle'].includes(msg.mode)) {
    return 'mode không hợp lệ.';
  }
  return null;
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(value);
}
