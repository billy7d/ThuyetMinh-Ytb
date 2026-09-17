import { describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  SessionRuntimeError,
  SessionRuntime,
  SessionStartRequest
} from '../../extension/src/background/session-manager.js';
import {
  ContentScriptHandshake,
  ContentHandshakePort
} from '../../extension/src/background/content-handshake.js';

const request: SessionStartRequest = {
  tabId: 7,
  mode: 'dubbing_and_subtitle',
  mixerConfig: { originalVolume: 30, originalMuted: false, ttsVolume: 80 }
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function runtimeMock(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    ensureReady: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    updateMixer: vi.fn(async () => {}),
    changeMode: vi.fn(async () => {}),
    ...overrides
  };
}

describe('production content handshake', () => {
  it('injects exactly once when the receiver is missing, then verifies READY', async () => {
    const port: ContentHandshakePort = {
      ping: vi.fn()
        .mockRejectedValueOnce(new SessionRuntimeError('CONTENT_UNREACHABLE', 'Receiving end does not exist.', true, true))
        .mockResolvedValue({ ready: true, hasVideo: true }),
      inject: vi.fn(async () => {})
    };
    const handshake = new ContentScriptHandshake(port);

    await Promise.all([
      handshake.ensureReady(3, new AbortController().signal),
      handshake.ensureReady(3, new AbortController().signal)
    ]);

    expect(port.inject).toHaveBeenCalledTimes(1);
    expect(port.ping).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permission denial or hide an injection failure', async () => {
    const port: ContentHandshakePort = {
      ping: vi.fn().mockRejectedValue(new SessionRuntimeError('CONTENT_UNREACHABLE', 'Cannot access restricted page.', true, true)),
      inject: vi.fn(async () => {
        throw new SessionRuntimeError('PERMISSION_DENIED', 'Permission denied.', false, true);
      })
    };
    const handshake = new ContentScriptHandshake(port);

    await expect(handshake.ensureReady(4, new AbortController().signal)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(port.ping).toHaveBeenCalledTimes(1);
    expect(port.inject).toHaveBeenCalledTimes(0);
  });

  it('loại bỏ handshake đang bị hủy để START mới không dùng flight cũ', async () => {
    const firstPing = deferred<ContentPingResponse>();
    const port: ContentHandshakePort = {
      ping: vi.fn()
        .mockReturnValueOnce(firstPing.promise)
        .mockResolvedValueOnce({ ready: true, hasVideo: true }),
      inject: vi.fn(async () => {})
    };
    const handshake = new ContentScriptHandshake(port);
    const controller = new AbortController();
    const first = handshake.ensureReady(5, controller.signal);

    controller.abort();
    const second = handshake.ensureReady(5, new AbortController().signal);
    firstPing.resolve({ ready: false });
    await expect(first).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    await second;
    expect(port.ping).toHaveBeenCalledTimes(2);
  });
});

describe('production session manager', () => {
  it('coalesces duplicate START requests into one initialization', async () => {
    const startGate = deferred<void>();
    const runtime = runtimeMock({ start: vi.fn(() => startGate.promise) });
    const manager = new SessionManager('test', runtime);

    const first = manager.start(request);
    await Promise.resolve();
    const second = manager.start(request);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().state).toBe('CONNECTING');

    startGate.resolve();
    await Promise.all([first, second]);
    expect(manager.getSnapshot().state).toBe('ACTIVE');
  });

  it('cancels START during initialization and never returns ACTIVE from a stale response', async () => {
    const startGate = deferred<void>();
    const runtime = runtimeMock({ start: vi.fn(() => startGate.promise) });
    const manager = new SessionManager('test', runtime);

    const startPromise = manager.start(request);
    await Promise.resolve();
    const stopPromise = manager.stop('user-cancelled');
    await stopPromise;
    startGate.resolve();

    await expect(startPromise).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(manager.getSnapshot().state).toBe('IDLE');
    expect(manager.getSnapshot().isCapturing).toBe(false);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the new session active when the old START resolves late', async () => {
    const startGates: Array<ReturnType<typeof deferred<void>>> = [];
    const runtime = runtimeMock({
      start: vi.fn(() => {
        const gate = deferred<void>();
        startGates.push(gate);
        return gate.promise;
      })
    });
    const manager = new SessionManager('test', runtime);

    const firstStart = manager.start(request);
    await Promise.resolve();
    const firstSessionId = manager.getSnapshot().sessionId;
    await manager.stop('replace');
    const secondStart = manager.start({ ...request, tabId: 8 });
    await Promise.resolve();

    expect(startGates).toHaveLength(2);
    startGates[0].resolve();
    await expect(firstStart).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    startGates[1].resolve();
    await secondStart;

    const snapshot = manager.getSnapshot();
    expect(snapshot.state).toBe('ACTIVE');
    expect(snapshot.tabId).toBe(8);
    expect(snapshot.sessionId).not.toBe(firstSessionId);
  });

  it('serializes concurrent START requests from different tabs', async () => {
    const startGates: Array<ReturnType<typeof deferred<void>>> = [];
    const runtime = runtimeMock({
      start: vi.fn(() => {
        const gate = deferred<void>();
        startGates.push(gate);
        return gate.promise;
      })
    });
    const manager = new SessionManager('test', runtime);

    const firstStart = manager.start(request);
    await Promise.resolve();
    const replacementStart = manager.start({ ...request, tabId: 8 });
    const duplicateReplacement = manager.start({ ...request, tabId: 9 });

    expect(duplicateReplacement).toBe(replacementStart);
    expect(runtime.stop).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(startGates).toHaveLength(2));
    startGates[0].resolve();
    await expect(firstStart).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    startGates[1].resolve();
    await replacementStart;

    expect(manager.getSnapshot().state).toBe('ACTIVE');
    expect(manager.getSnapshot().tabId).toBe(8);
  });

  it('cleans resources and exposes a non-active ERROR after WebSocket disconnect', async () => {
    const runtime = runtimeMock();
    const manager = new SessionManager('test', runtime);
    await manager.start(request);
    const sessionId = manager.getSnapshot().sessionId as string;

    await manager.handleRuntimeEvent({
      sessionId,
      error: { code: 'WS_DISCONNECTED', message: 'Máy chủ WebSocket đã ngắt kết nối.', retryable: true, fatal: true }
    });

    expect(manager.getSnapshot().state).toBe('ERROR');
    expect(manager.getSnapshot().isCapturing).toBe(false);
    expect(manager.getSnapshot().error?.code).toBe('WS_DISCONNECTED');
    expect(runtime.stop).toHaveBeenCalledTimes(1);

    await manager.stop('user');
    expect(manager.getSnapshot().state).toBe('IDLE');
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('propagates timeout once, performs cleanup, and does not auto-retry', async () => {
    const runtime = runtimeMock({
      start: vi.fn(async () => {
        throw new SessionRuntimeError('WS_CONNECTION_TIMEOUT', 'Timeout.', true, true);
      })
    });
    const manager = new SessionManager('test', runtime);

    await expect(manager.start(request)).rejects.toMatchObject({ code: 'WS_CONNECTION_TIMEOUT' });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().state).toBe('ERROR');
  });
});
