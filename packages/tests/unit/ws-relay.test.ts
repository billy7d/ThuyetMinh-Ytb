import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RelaySocket,
  SOCKET_CLOSED,
  SOCKET_OPEN,
  WS_RELAY_PORT_NAME,
  attachWsRelay,
  isAllowedBackendUrl
} from '../../extension/src/relay/ws-relay.js';

type Listener = (message: any) => void;

/** Cặp Port giả nối content ↔ background giống runtime.connect. */
function createPortPair(sender: { tab?: unknown } = { tab: { id: 1 } }) {
  const contentListeners: Listener[] = [];
  const backgroundListeners: Listener[] = [];
  const contentDisconnect: Array<() => void> = [];
  const backgroundDisconnect: Array<() => void> = [];
  let connected = true;
  const disconnect = () => {
    if (!connected) return;
    connected = false;
    contentDisconnect.forEach(listener => listener());
    backgroundDisconnect.forEach(listener => listener());
  };
  const contentPort = {
    name: WS_RELAY_PORT_NAME,
    postMessage: (message: unknown) => {
      if (!connected) throw new Error('disconnected');
      queueMicrotask(() => backgroundListeners.forEach(listener => listener(message)));
    },
    disconnect,
    onMessage: { addListener: (listener: Listener) => contentListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => contentDisconnect.push(listener) }
  };
  const backgroundPort = {
    name: WS_RELAY_PORT_NAME,
    sender,
    postMessage: (message: unknown) => {
      if (!connected) throw new Error('disconnected');
      queueMicrotask(() => contentListeners.forEach(listener => listener(message)));
    },
    disconnect,
    onMessage: { addListener: (listener: Listener) => backgroundListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => backgroundDisconnect.push(listener) }
  };
  return { contentPort, backgroundPort, disconnect };
}

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(sender?: { tab?: unknown }) {
  const sockets: FakeWebSocket[] = [];
  let connectListener: ((port: any) => void) | null = null;
  attachWsRelay({ addListener: listener => { connectListener = listener; } }, url => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const pair = createPortPair(sender);
  connectListener!(pair.backgroundPort);
  return { sockets, pair };
}

describe('Firefox WebSocket relay', () => {
  it('mở WebSocket ở background và chuyển dữ liệu hai chiều', async () => {
    const { sockets, pair } = setup();
    const socket = new RelaySocket('ws://127.0.0.1:8080', pair.contentPort);
    const received: string[] = [];
    let opened = false;
    socket.onopen = () => { opened = true; };
    socket.onmessage = event => received.push(event.data);
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://127.0.0.1:8080');

    sockets[0].open();
    await flush();
    expect(opened).toBe(true);
    expect(socket.readyState).toBe(SOCKET_OPEN);

    socket.send('{"type":"SESSION_START"}');
    await flush();
    expect(sockets[0].sent).toEqual(['{"type":"SESSION_START"}']);

    sockets[0].onmessage?.({ data: '{"type":"SESSION_READY"}' });
    await flush();
    expect(received).toEqual(['{"type":"SESSION_READY"}']);
  });

  it('từ chối URL không phải loopback và Port không đến từ tab', async () => {
    const remote = setup();
    const remoteSocket = new RelaySocket('wss://example.com/ws', remote.pair.contentPort);
    let remoteClose: number | null = null;
    remoteSocket.onclose = event => { remoteClose = event.code; };
    await flush(); await flush();
    expect(remote.sockets).toHaveLength(0);
    expect(remoteClose).toBe(1008);

    const noTab = setup({});
    new RelaySocket('ws://127.0.0.1:8080', noTab.pair.contentPort);
    await flush();
    expect(noTab.sockets).toHaveLength(0);
  });

  it('đóng WebSocket backend khi tab tải lại (Port bị ngắt)', async () => {
    const { sockets, pair } = setup();
    const socket = new RelaySocket('ws://127.0.0.1:8080', pair.contentPort);
    let closeCode: number | null = null;
    socket.onclose = event => { closeCode = event.code; };
    await flush();
    sockets[0].open();
    await flush();
    pair.disconnect();
    expect(sockets[0].closed).toBe(true);
    expect(socket.readyState).toBe(SOCKET_CLOSED);
    expect(closeCode).toBe(1006);
  });

  it('manifest Firefox không tự nâng ws:// lên wss:// (backend local không có TLS)', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.firefox.json', import.meta.url), 'utf8'));
    const csp: string = manifest.content_security_policy?.extension_pages ?? '';
    // Không khai báo thì Firefox MV3 dùng CSP mặc định có upgrade-insecure-requests.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('chỉ chấp nhận địa chỉ backend loopback', () => {
    expect(isAllowedBackendUrl('ws://127.0.0.1:8080')).toBe(true);
    expect(isAllowedBackendUrl('ws://localhost:8080')).toBe(true);
    expect(isAllowedBackendUrl('ws://192.168.1.5:8080')).toBe(false);
    expect(isAllowedBackendUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isAllowedBackendUrl('not a url')).toBe(false);
  });
});
