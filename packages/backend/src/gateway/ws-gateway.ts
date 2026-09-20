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
  }

  getProviderStatus(): { configured: boolean; missingConfiguration: string[] } {
    return {
      configured: this.providerFactory.missingConfiguration.length === 0,
      missingConfiguration: [...this.providerFactory.missingConfiguration]
    };
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      let currentSessionId: string | null = null;

      ws.on('message', (rawData: Buffer | string) => {
        try {
          const msg = JSON.parse(rawData.toString()) as ClientMessage;
          currentSessionId = msg.sessionId;
          this.handleClientMessage(ws, msg);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid message';
          this.sendSafe(ws, {
            type: 'ERROR',
            sessionId: currentSessionId || 'unknown',
            timestamp: Date.now(),
            code: 'INVALID_MESSAGE',
            message,
            fatal: false
          });
        }
      });

      ws.on('close', () => {
        if (currentSessionId) this.terminateSession(currentSessionId, ws);
      });

      ws.on('error', () => {
        if (currentSessionId) this.terminateSession(currentSessionId, ws);
      });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'SESSION_START': {
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

        this.terminateSession(msg.sessionId);
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
  }
}
