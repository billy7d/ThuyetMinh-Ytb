import { SessionRuntimeError, toSessionError } from './session-manager.js';

export interface ContentPingResponse {
  ready?: boolean;
  hasVideo?: boolean;
  videoTitle?: string;
}

export interface ContentHandshakePort {
  ping: (tabId: number) => Promise<ContentPingResponse>;
  inject: (tabId: number) => Promise<void>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SessionRuntimeError('SESSION_CANCELLED', 'Phiên khởi tạo đã bị hủy.', false, false);
  }
}

function normalizeHandshakeError(error: unknown): SessionRuntimeError {
  const sessionError = toSessionError(error, 'CONTENT_UNREACHABLE');
  const lower = sessionError.message.toLowerCase();
  if (
    sessionError.code === 'PERMISSION_DENIED' ||
    lower.includes('permission') ||
    lower.includes('not allowed') ||
    lower.includes('cannot access') ||
    lower.includes('restricted')
  ) {
    return new SessionRuntimeError('PERMISSION_DENIED', sessionError.message, false, true);
  }
  return new SessionRuntimeError(sessionError.code, sessionError.message, sessionError.retryable, sessionError.fatal);
}

export class ContentScriptHandshake {
  private readonly port: ContentHandshakePort;
  private readonly flights = new Map<number, Promise<void>>();

  constructor(port: ContentHandshakePort) {
    this.port = port;
  }

  ensureReady(tabId: number, signal: AbortSignal): Promise<void> {
    const existingFlight = this.flights.get(tabId);
    if (existingFlight) return existingFlight;

    const flight = (async () => {
      throwIfAborted(signal);
      try {
        const response = await this.port.ping(tabId);
        if (response?.ready) return;
      } catch (error) {
        const normalized = normalizeHandshakeError(error);
        if (normalized.code === 'PERMISSION_DENIED') throw normalized;
      }

      throwIfAborted(signal);
      // Một flight chỉ thử inject đúng một lần rồi xác nhận lại receiver.
      await this.port.inject(tabId);
      throwIfAborted(signal);
      const response = await this.port.ping(tabId);
      if (!response?.ready) {
        throw new SessionRuntimeError('CONTENT_NOT_READY', 'Content script đã nạp nhưng chưa sẵn sàng.', true, true);
      }
    })();

    this.flights.set(tabId, flight);
    const removeAbortedFlight = () => {
      if (this.flights.get(tabId) === flight) this.flights.delete(tabId);
    };
    signal.addEventListener('abort', removeAbortedFlight, { once: true });
    flight.then(
      () => {
        signal.removeEventListener('abort', removeAbortedFlight);
        if (this.flights.get(tabId) === flight) this.flights.delete(tabId);
      },
      () => {
        signal.removeEventListener('abort', removeAbortedFlight);
        if (this.flights.get(tabId) === flight) this.flights.delete(tabId);
      }
    );
    return flight;
  }
}
