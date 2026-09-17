import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage,
  ServerMessage,
  SessionReadyMessage,
  SessionMetricsMessage,
  DEFAULT_MODE
} from '@vietdub/shared';
import { RealtimePipeline } from '../pipeline/realtime-pipeline.js';
import { MockSTTProvider } from '../stt/mock-stt.js';
import { TranslationEngine } from '../translation/translation-engine.js';
import { VietnameseTTSEngine } from '../tts/tts-engine.js';

export class WebSocketGateway {
  private wss: WebSocketServer;
  private activeSessions = new Map<string, { pipeline: RealtimePipeline; ws: WebSocket }>();

  constructor(wss: WebSocketServer) {
    this.wss = wss;
    this.setupConnectionHandler();
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      let currentSessionId: string | null = null;

      ws.on('message', (rawData: Buffer | string) => {
        try {
          const msg = JSON.parse(rawData.toString()) as ClientMessage;
          currentSessionId = msg.sessionId;
          this.handleClientMessage(ws, msg);
        } catch (err: any) {
          console.error('[WSGateway] Message parse error:', err);
          this.sendSafe(ws, {
            type: 'ERROR',
            sessionId: currentSessionId || 'unknown',
            timestamp: Date.now(),
            code: 'INVALID_JSON',
            message: err.message,
            fatal: false
          });
        }
      });

      ws.on('close', () => {
        if (currentSessionId) {
          this.terminateSession(currentSessionId);
        }
      });

      ws.on('error', (err) => {
        console.error('[WSGateway] Socket error:', err);
        if (currentSessionId) {
          this.terminateSession(currentSessionId);
        }
      });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'SESSION_START': {
        const sessionId = msg.sessionId;
        const mode = msg.mode || DEFAULT_MODE;

        // Clean up any existing session with this ID
        this.terminateSession(sessionId);

        const sttProvider = new MockSTTProvider();
        const translationEngine = new TranslationEngine();
        const ttsEngine = new VietnameseTTSEngine();

        const pipeline = new RealtimePipeline(
          sessionId,
          mode,
          sttProvider,
          translationEngine,
          ttsEngine,
          {
            sendMessage: (serverMsg) => this.sendSafe(ws, serverMsg)
          }
        );

        this.activeSessions.set(sessionId, { pipeline, ws });
        pipeline.start();

        const readyMsg: SessionReadyMessage = {
          type: 'SESSION_READY',
          sessionId,
          timestamp: Date.now(),
          sessionConfig: {
            audioSampleRate: msg.audioSampleRate || 16000,
            chunkDurationMs: 250
          }
        };
        this.sendSafe(ws, readyMsg);
        break;
      }

      case 'AUDIO_CHUNK': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session) {
          const pcmBuffer = Buffer.from(msg.pcmBase64, 'base64');
          session.pipeline.handleAudioChunk(pcmBuffer, msg.timestampMs);
        }
        break;
      }

      case 'SEEK_EVENT': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session) {
          session.pipeline.handleSeek(msg.fromMs, msg.toMs);
        }
        break;
      }

      case 'MODE_CHANGE': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session) {
          session.pipeline.setMode(msg.mode);
        }
        break;
      }

      case 'SESSION_STOP': {
        const session = this.activeSessions.get(msg.sessionId);
        if (session) {
          const metrics = session.pipeline.getCostTracker().getMetrics();
          const metricsMsg: SessionMetricsMessage = {
            type: 'SESSION_METRICS',
            sessionId: msg.sessionId,
            timestamp: Date.now(),
            metrics
          };
          this.sendSafe(ws, metricsMsg);
          this.terminateSession(msg.sessionId);
        }
        break;
      }
    }
  }

  private sendSafe(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  terminateSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.pipeline.stop();
      this.activeSessions.delete(sessionId);
    }
  }

  close(): void {
    for (const [id] of this.activeSessions) {
      this.terminateSession(id);
    }
    this.wss.close();
  }
}
