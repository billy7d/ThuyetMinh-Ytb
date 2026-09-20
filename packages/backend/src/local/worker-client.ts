import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface LocalWorkerCommand {
  /** Absolute executable path or an executable resolved by PATH. */
  command: string;
  /** Arguments are passed as an array. They are never interpreted by a shell. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface LocalWorkerClientOptions {
  name: string;
  command: LocalWorkerCommand;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxQueueSize?: number;
  maxFrameBytes?: number;
}

export interface LocalWorkerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalWorkerClientLike {
  start?(): Promise<void>;
  getStatus?(): LocalWorkerStatus;
  request<T>(payload: Record<string, unknown>, options?: LocalWorkerRequestOptions): Promise<T>;
  close(): Promise<void>;
}

export interface LocalWorkerStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error' | 'closed';
  error?: string;
  pendingRequests: number;
}

interface WorkerResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE_SIZE = 32;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Small JSON-lines RPC transport for local inference workers.
 *
 * The worker contract is intentionally narrow:
 *   1. emit {"event":"ready"} once models are loaded;
 *   2. accept {"id": string, ...payload} lines;
 *   3. reply with {"id": string, "ok": true, "result": ...} or
 *      {"id": string, "ok": false, "error": string}.
 *
 * Browser data is sent as JSON data only. It is never interpolated into a
 * command line and the child process is always spawned with shell:false.
 */
export class JsonLineWorkerClient implements LocalWorkerClientLike {
  private readonly name: string;
  private readonly command: LocalWorkerCommand;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly maxFrameBytes: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private requestReservations = 0;
  private closed = false;
  private state: LocalWorkerStatus['state'] = 'stopped';
  private lastError: string | undefined;

  constructor(options: LocalWorkerClientOptions) {
    this.name = options.name;
    this.command = options.command;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

    if (!this.command.command.trim()) {
      throw new Error(`${this.name} worker command is empty`);
    }
    if (this.maxQueueSize < 1 || this.maxFrameBytes < 1024) {
      throw new Error(`${this.name} worker limits are invalid`);
    }
  }

  async request<T>(payload: Record<string, unknown>, options: LocalWorkerRequestOptions = {}): Promise<T> {
    if (this.closed) throw new Error(`${this.name} worker is closed`);
    if (this.pending.size + this.requestReservations >= this.maxQueueSize) {
      throw new Error(`${this.name} worker queue exceeded ${this.maxQueueSize} pending requests`);
    }

    this.requestReservations++;
    try {
      await this.start();
      if (options.signal?.aborted) throw abortError(`${this.name} request was cancelled`);
    } catch (error) {
      this.requestReservations--;
      throw error;
    }
    this.requestReservations--;

    const id = randomUUID();
    const message = JSON.stringify({ id, ...payload });
    const frameBytes = Buffer.byteLength(message, 'utf8') + 1;
    if (frameBytes > this.maxFrameBytes) {
      throw new Error(`${this.name} worker frame exceeded ${this.maxFrameBytes} bytes`);
    }

    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error(`${this.name} worker stdin is unavailable`);

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: PendingRequest = {
        resolve: value => resolve(value as T),
        reject,
        timer,
        signal: options.signal
      };
      if (options.signal) {
        pending.abortListener = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(abortError(`${this.name} request was cancelled`));
        };
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);

      try {
        child.stdin.write(`${message}\n`);
      } catch (error) {
        this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  getStatus(): LocalWorkerStatus {
    return {
      state: this.state,
      error: this.lastError,
      pendingRequests: this.pending.size + this.requestReservations
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    const child = this.child;
    this.child = null;
    this.readyReject?.(new Error(`${this.name} worker closed`));
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    this.rejectAll(new Error(`${this.name} worker closed`));
    if (!child) return;

    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The worker may already have exited.
      }
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error(`${this.name} worker is closed`);
    if (this.readyPromise) return this.readyPromise;

    this.state = 'starting';
    this.lastError = undefined;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const child = spawn(this.command.command, this.command.args ?? [], {
        cwd: this.command.cwd,
        env: { ...process.env, ...this.command.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child;

      const startupTimer = setTimeout(() => {
        this.failWorker(new Error(`${this.name} worker did not become ready within ${this.startupTimeoutMs}ms`));
      }, this.startupTimeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', () => {});
      child.once('error', error => {
        clearTimeout(startupTimer);
        this.failWorker(new Error(`${this.name} worker failed to start: ${error.message}`));
      });
      child.once('exit', (code, signal) => {
        clearTimeout(startupTimer);
        // Worker stderr is deliberately not returned to the browser/health
        // endpoint because it may contain model paths or user data.
        this.failWorker(new Error(`${this.name} worker exited with ${signal || `code ${code}`}`));
      });
    });

    try {
      await this.readyPromise;
      this.state = 'ready';
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.readyPromise = null;
      throw error;
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxFrameBytes * 2) {
      this.failWorker(new Error(`${this.name} worker emitted an oversized output buffer`));
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
      this.failWorker(new Error(`${this.name} worker response exceeded ${this.maxFrameBytes} bytes`));
      return;
    }
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      this.failWorker(new Error(`${this.name} worker emitted invalid JSON`));
      return;
    }

    if (response.event === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (!response.id) {
      this.failWorker(new Error(`${this.name} worker response is missing an id`));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    if (response.ok === false) {
      pending.reject(new Error(response.error || `${this.name} worker request failed`));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of this.pending.keys()) this.rejectPending(id, error);
  }

  private failWorker(error: Error): void {
    if (!this.closed) {
      this.state = 'error';
      this.lastError = error.message;
    }
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.rejectAll(error);
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
}

export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
