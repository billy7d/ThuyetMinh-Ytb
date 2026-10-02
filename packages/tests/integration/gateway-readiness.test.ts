import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer, ProductionProviderFactory } from '@vietdub/backend';
import { ServerMessage } from '@vietdub/shared';
import { createFixtureProviderFactory } from '../src/fixtures/provider-factory.js';

async function withGateway(
  providerFactory: ProductionProviderFactory,
  runtimeReadyTimeoutMs: number,
  run: (socket: WebSocket, messages: ServerMessage[]) => Promise<void>
): Promise<void> {
  const { server, gateway } = createServer(0, { providerFactory, runtimeReadyTimeoutMs });
  const messages: ServerMessage[] = [];
  let socket: WebSocket | null = null;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Không lấy được cổng gateway test.');
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await once(socket, 'open');
    await run(socket, messages);
  } finally {
    socket?.close();
    gateway.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function sessionStart(sessionId: string): string {
  return JSON.stringify({ type: 'SESSION_START', sessionId, timestamp: Date.now(), mode: 'subtitle_only', audioSampleRate: 16000 });
}

async function waitFor(messages: ServerMessage[], predicate: (message: ServerMessage) => boolean, timeoutMs = 2_000): Promise<ServerMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Không nhận được message mong đợi.');
}

describe('gateway runtime readiness (P2)', () => {
  it('chỉ gửi SESSION_READY sau khi worker local đã sẵn sàng', async () => {
    let releaseWarmup!: () => void;
    const warmupGate = new Promise<void>(resolve => { releaseWarmup = resolve; });
    let warmupCalls = 0;
    const factory: ProductionProviderFactory = {
      ...createFixtureProviderFactory(),
      warmup: async () => {
        warmupCalls++;
        await warmupGate;
      }
    };
    await withGateway(factory, 5_000, async (socket, messages) => {
      socket.send(sessionStart('ready_after_warmup'));
      // Extension vẫn gửi trạng thái video trong lúc chờ; gateway không được trả lỗi ownership cho các message này.
      socket.send(JSON.stringify({
        type: 'VIDEO_STATE_UPDATE',
        sessionId: 'ready_after_warmup',
        timestamp: Date.now(),
        state: { currentTime: 1, duration: 10, paused: false, playbackRate: 1, seeking: false }
      }));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(messages.some(message => message.type === 'SESSION_READY')).toBe(false);
      expect(messages.some(message => message.type === 'ERROR')).toBe(false);
      releaseWarmup();
      await waitFor(messages, message => message.type === 'SESSION_READY');
      expect(warmupCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it('trả lỗi nghiêm trọng rõ ràng khi model chưa khởi động kịp hoặc khởi động thất bại', async () => {
    const warming: ProductionProviderFactory = {
      ...createFixtureProviderFactory(),
      warmup: () => new Promise<void>(() => {})
    };
    await withGateway(warming, 100, async (socket, messages) => {
      socket.send(sessionStart('warming_timeout'));
      const error = await waitFor(messages, message => message.type === 'ERROR');
      expect(error).toMatchObject({ code: 'LOCAL_RUNTIME_WARMING', fatal: true });
    });

    let attempts = 0;
    const failing: ProductionProviderFactory = {
      ...createFixtureProviderFactory(),
      warmup: async () => {
        attempts++;
        if (attempts > 1) throw new Error('Local STT worker failed to start');
      }
    };
    await withGateway(failing, 1_000, async (socket, messages) => {
      socket.send(sessionStart('warmup_failed'));
      const error = await waitFor(messages, message => message.type === 'ERROR');
      expect(error).toMatchObject({ code: 'LOCAL_RUNTIME_NOT_READY', fatal: true });
      expect(messages.some(message => message.type === 'SESSION_READY')).toBe(false);
    });
  });

  it('không tạo pipeline mồ côi khi kết nối đóng trong lúc chờ model', async () => {
    let releaseWarmup!: () => void;
    const warmupGate = new Promise<void>(resolve => { releaseWarmup = resolve; });
    let created = 0;
    const base = createFixtureProviderFactory();
    const factory: ProductionProviderFactory = {
      ...base,
      create: () => {
        created++;
        return base.create();
      },
      warmup: async () => warmupGate
    };
    await withGateway(factory, 5_000, async (socket) => {
      socket.send(sessionStart('closed_while_warming'));
      await new Promise(resolve => setTimeout(resolve, 50));
      socket.close();
      await once(socket, 'close');
      releaseWarmup();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(created).toBe(0);
    });
  });
});
