/**
 * Relay WebSocket qua background cho Firefox.
 *
 * Trong Firefox, WebSocket mở từ content script mang Origin của trang (ví dụ
 * https://www.youtube.com). Backend local chỉ nhận Origin của extension/loopback
 * nên từ chối (HTTP 403) mọi kết nối — phiên luôn báo "Không thể kết nối máy chủ AI".
 * Content script vì vậy gửi dữ liệu qua runtime Port; background (Origin
 * moz-extension://) mới là nơi mở WebSocket thật.
 */

export const WS_RELAY_PORT_NAME = 'vietdub-ws-relay';

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/** Tập con của WebSocket mà content script sử dụng. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

type RelayToBackground =
  | { type: 'open'; url: string }
  | { type: 'send'; data: string }
  | { type: 'close' };

type RelayToContent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'error'; reason?: string }
  | { type: 'close'; code: number; reason: string };

interface PortLike {
  name: string;
  sender?: { tab?: unknown; id?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: any) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

/** Chỉ cho phép relay tới backend chạy trên máy (loopback); không dùng làm proxy ra Internet. */
export function isAllowedBackendUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** Phía content script: đối tượng giống WebSocket, truyền qua runtime Port tới background. */
export class RelaySocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  private state = SOCKET_CONNECTING;
  private closeNotified = false;

  constructor(url: string, private readonly port: PortLike) {
    port.onMessage.addListener((message: RelayToContent) => this.handle(message));
    port.onDisconnect.addListener(() => this.finish(1006, 'relay port disconnected'));
    this.post({ type: 'open', url });
  }

  get readyState(): number {
    return this.state;
  }

  send(data: string): void {
    if (this.state !== SOCKET_OPEN) throw new Error('Relay socket is not open');
    this.post({ type: 'send', data });
  }

  close(): void {
    if (this.state === SOCKET_CLOSED || this.state === SOCKET_CLOSING) return;
    this.state = SOCKET_CLOSING;
    this.post({ type: 'close' });
    // Background sẽ báo close; nếu Port đã chết thì tự kết thúc để cleanup không bị treo.
    setTimeout(() => this.finish(1000, 'closed by client'), 1_000);
  }

  private handle(message: RelayToContent): void {
    switch (message?.type) {
      case 'open':
        if (this.state !== SOCKET_CONNECTING) return;
        this.state = SOCKET_OPEN;
        this.onopen?.({ type: 'open' });
        return;
      case 'message':
        if (this.state === SOCKET_OPEN) this.onmessage?.({ data: message.data });
        return;
      case 'error':
        this.onerror?.({ type: 'error', reason: message.reason });
        return;
      case 'close':
        this.finish(message.code, message.reason);
        return;
    }
  }

  private finish(code: number, reason: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.state = SOCKET_CLOSED;
    try {
      this.port.disconnect();
    } catch {
      // Port đã đóng.
    }
    this.onclose?.({ code, reason });
  }

  private post(message: RelayToBackground): void {
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.onerror?.({ type: 'error', reason: String(error) });
      this.finish(1006, 'relay port unavailable');
    }
  }
}

/** Phía background: mở WebSocket thật cho mỗi Port từ content script và chuyển tiếp dữ liệu hai chiều. */
export function attachWsRelay(
  onConnect: { addListener(listener: (port: PortLike) => void): void },
  createSocket: (url: string) => WebSocket = url => new WebSocket(url),
  /** Gọi khi Port của một tab (đã mở WebSocket) bị ngắt; background quyết định có phải phiên bị mất ngoài ý muốn không. */
  onUnexpectedDisconnect?: (tabId: number) => void
): void {
  onConnect.addListener(port => {
    if (port.name !== WS_RELAY_PORT_NAME) return;
    let socket: WebSocket | null = null;
    let portOpen = true;
    const post = (message: RelayToContent) => {
      if (!portOpen) return;
      try {
        port.postMessage(message);
      } catch {
        portOpen = false;
      }
    };

    port.onMessage.addListener((message: RelayToBackground) => {
      if (message?.type === 'open') {
        if (socket) return;
        // Chỉ content script của tab mới được mở relay; trang web không truy cập được Port này.
        if (!port.sender?.tab || !isAllowedBackendUrl(message.url)) {
          post({ type: 'error', reason: 'Backend URL must be a loopback WebSocket' });
          post({ type: 'close', code: 1008, reason: 'relay rejected' });
          return;
        }
        try {
          socket = createSocket(message.url);
        } catch (error) {
          post({ type: 'error', reason: String(error) });
          post({ type: 'close', code: 1006, reason: 'socket construction failed' });
          return;
        }
        socket.onopen = () => post({ type: 'open' });
        socket.onmessage = event => post({ type: 'message', data: String(event.data) });
        socket.onerror = () => post({ type: 'error', reason: `WebSocket error connecting to ${message.url}` });
        socket.onclose = event => {
          console.warn('[WS-RELAY] backend socket closed', JSON.stringify({ code: event.code, reason: event.reason }));
          post({ type: 'close', code: event.code, reason: event.reason });
        };
        return;
      }
      if (message?.type === 'send') {
        if (socket?.readyState === SOCKET_OPEN) socket.send(message.data);
        return;
      }
      if (message?.type === 'close') {
        socket?.close();
      }
    });

    port.onDisconnect.addListener(() => {
      portOpen = false;
      // Kể cả khi content kịp gửi "close" lúc beforeunload, background vẫn phải biết phiên đã mất;
      // SessionManager tự bỏ qua trường hợp người dùng chủ động dừng (phiên không còn ACTIVE).
      const hadSocket = socket !== null;
      // Tab đóng/tải lại: đóng WebSocket để backend dừng pipeline ngay.
      try {
        socket?.close();
      } catch {
        // Socket đã đóng.
      }
      socket = null;
      const tabId = (port.sender?.tab as { id?: number } | undefined)?.id;
      if (hadSocket && typeof tabId === 'number') onUnexpectedDisconnect?.(tabId);
    });
  });
}
