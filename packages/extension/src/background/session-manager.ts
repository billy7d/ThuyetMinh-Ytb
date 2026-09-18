import {
  AudioMixerConfig,
  DEFAULT_MODE,
  DEFAULT_ORIGINAL_VOLUME,
  DEFAULT_TTS_VOLUME,
  OperationMode,
  SessionState,
  VideoPlaybackState
} from '@vietdub/shared';

export interface SessionError {
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
}

export interface SessionSnapshot {
  state: SessionState;
  sessionId: string | null;
  tabId: number | null;
  mode: OperationMode;
  mixerConfig: AudioMixerConfig;
  generation: number;
  error: SessionError | null;
  isCapturing: boolean;
}

export interface SessionStartRequest {
  tabId: number;
  mode: OperationMode;
  mixerConfig: AudioMixerConfig;
  wsUrl?: string;
  sessionId?: string;
}

export interface SessionRuntimeEvent {
  sessionId: string;
  state?: Extract<SessionState, 'READY' | 'ACTIVE' | 'ERROR'>;
  error?: Partial<SessionError> & { message: string };
}

export interface SessionRuntime {
  ensureReady: (tabId: number, signal: AbortSignal) => Promise<void>;
  start: (request: SessionStartRequest & { sessionId: string }, signal: AbortSignal) => Promise<void>;
  stop: (request: SessionStartRequest, reason: string) => Promise<void>;
  updateMixer?: (request: SessionStartRequest, config: AudioMixerConfig) => Promise<void>;
  changeMode?: (request: SessionStartRequest, mode: OperationMode) => Promise<void>;
  seek?: (request: SessionStartRequest, fromMs: number, toMs: number) => Promise<void>;
  videoState?: (request: SessionStartRequest, state: VideoPlaybackState) => Promise<void>;
}

export class SessionRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly fatal: boolean;

  constructor(code: string, message: string, retryable = false, fatal = true) {
    super(message);
    this.name = 'SessionRuntimeError';
    this.code = code;
    this.retryable = retryable;
    this.fatal = fatal;
  }
}

export class SessionCancelledError extends SessionRuntimeError {
  constructor() {
    super('SESSION_CANCELLED', 'Phiên khởi tạo đã bị hủy.', false, false);
    this.name = 'SessionCancelledError';
  }
}

export function toSessionError(error: unknown, fallbackCode = 'SESSION_ERROR'): SessionError {
  if (error instanceof SessionRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fatal: error.fatal
    };
  }

  const candidate = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    fatal?: unknown;
  };

  return {
    code: typeof candidate.code === 'string' ? candidate.code : fallbackCode,
    message: typeof candidate.message === 'string' && candidate.message.length > 0
      ? candidate.message
      : 'Đã xảy ra lỗi trong vòng đời phiên.',
    retryable: candidate.retryable === true,
    fatal: candidate.fatal !== false
  };
}

interface SessionRecord {
  request: SessionStartRequest;
  generation: number;
  controller: AbortController;
  cancelled: boolean;
  runtimeFailureHandled: boolean;
  startPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  cleanupPromise: Promise<void> | null;
}

interface PendingStart {
  cancelled: boolean;
  promise: Promise<void>;
}

export type SessionChangeHandler = (snapshot: SessionSnapshot) => void;

function cloneMixerConfig(config: AudioMixerConfig): AudioMixerConfig {
  return { ...config };
}

function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    mixerConfig: cloneMixerConfig(snapshot.mixerConfig),
    error: snapshot.error ? { ...snapshot.error } : null
  };
}

function createSessionId(prefix: string, sequence: number): string {
  // UUID giúp tránh trùng phiên khi nhiều lượt START xảy ra trong cùng mili giây.
  const randomUuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `sess_${prefix}_${sequence}_${randomUuid}`;
}

export class SessionManager {
  private readonly runtime: SessionRuntime;
  private readonly onChange: SessionChangeHandler;
  private readonly idPrefix: string;
  private sessionSequence = 0;
  private lifecycleGeneration = 0;
  private currentRecord: SessionRecord | null = null;
  private pendingStart: PendingStart | null = null;
  private snapshot: SessionSnapshot;

  constructor(idPrefix: string, runtime: SessionRuntime, onChange: SessionChangeHandler = () => {}) {
    this.idPrefix = idPrefix;
    this.runtime = runtime;
    this.onChange = onChange;
    this.snapshot = {
      state: 'IDLE',
      sessionId: null,
      tabId: null,
      mode: DEFAULT_MODE,
      mixerConfig: {
        originalVolume: DEFAULT_ORIGINAL_VOLUME,
        originalMuted: false,
        ttsVolume: DEFAULT_TTS_VOLUME
      },
      generation: 0,
      error: null,
      isCapturing: false
    };
  }

  getSnapshot(): SessionSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  start(request: SessionStartRequest): Promise<void> {
    if (this.pendingStart) return this.pendingStart.promise;

    const current = this.currentRecord;
    if (current && !current.cancelled && current.request.tabId === request.tabId) {
      if (this.snapshot.state === 'ACTIVE') return Promise.resolve();
      if (current.startPromise && ['INITIALIZING', 'READY', 'CONNECTING'].includes(this.snapshot.state)) {
        // Double-click chỉ nhận cùng một promise, không tạo AudioContext hay WebSocket thứ hai.
        return current.startPromise;
      }
    }

    if (current) {
      const stopPromise = this.stop('replaced-by-new-start');
      const pendingStart = { cancelled: false, promise: Promise.resolve() } satisfies PendingStart;
      const replacementPromise = stopPromise.then(() => {
        if (pendingStart.cancelled) throw new SessionCancelledError();
        return this.beginStart(request);
      });
      pendingStart.promise = replacementPromise;
      this.pendingStart = pendingStart;
      replacementPromise.then(
        () => {
          if (this.pendingStart === pendingStart) this.pendingStart = null;
        },
        () => {
          if (this.pendingStart === pendingStart) this.pendingStart = null;
        }
      );
      return replacementPromise;
    }

    return this.beginStart(request);
  }

  private beginStart(request: SessionStartRequest): Promise<void> {
    if (!Number.isInteger(request.tabId) || request.tabId < 0) {
      const error = new SessionRuntimeError('INVALID_TAB', 'Tab video không hợp lệ.', false, true);
      this.updateSnapshot({
        state: 'ERROR',
        sessionId: null,
        tabId: null,
        error: toSessionError(error),
        isCapturing: false
      });
      return Promise.reject(error);
    }

    const normalizedRequest: SessionStartRequest = {
      ...request,
      mode: request.mode || DEFAULT_MODE,
      mixerConfig: { ...this.snapshot.mixerConfig, ...request.mixerConfig }
    };
    const record: SessionRecord = {
      request: normalizedRequest,
      generation: ++this.lifecycleGeneration,
      controller: new AbortController(),
      cancelled: false,
      runtimeFailureHandled: false,
      startPromise: null,
      stopPromise: null,
      cleanupPromise: null
    };

    const sessionId = createSessionId(this.idPrefix, ++this.sessionSequence);
    normalizedRequest.sessionId = sessionId;
    this.currentRecord = record;
    this.updateSnapshot({
      state: 'INITIALIZING',
      sessionId: normalizedRequest.tabId >= 0 ? sessionId : null,
      tabId: normalizedRequest.tabId,
      mode: normalizedRequest.mode,
      mixerConfig: cloneMixerConfig(normalizedRequest.mixerConfig),
      generation: record.generation,
      error: null
    });

    const startPromise = this.runStart(record, sessionId);
    record.startPromise = startPromise;
    startPromise.then(
      () => {
        if (record.startPromise === startPromise) record.startPromise = null;
      },
      () => {
        if (record.startPromise === startPromise) record.startPromise = null;
      }
    );
    return startPromise;
  }

  private async runStart(record: SessionRecord, sessionId: string): Promise<void> {
    try {
      await this.runtime.ensureReady(record.request.tabId, record.controller.signal);
      this.assertCurrent(record, sessionId);
      this.updateSnapshot({ state: 'READY' });

      this.assertCurrent(record, sessionId);
      this.updateSnapshot({ state: 'CONNECTING' });
      await this.runtime.start(record.request as SessionStartRequest & { sessionId: string }, record.controller.signal);
      this.assertCurrent(record, sessionId);
      this.updateSnapshot({ state: 'ACTIVE', error: null, isCapturing: true });
    } catch (error) {
      const cancelled = record.cancelled || !this.isCurrent(record) || error instanceof SessionCancelledError;
      await this.cleanupRecord(record, cancelled ? 'start-cancelled' : 'start-failed').catch((cleanupError) => {
        // Không nuốt lỗi cleanup; log vẫn giữ mã lỗi để chẩn đoán được nguyên nhân thật.
        console.error('[SessionManager] cleanup failed', JSON.stringify(toSessionError(cleanupError, 'CLEANUP_FAILED')));
      });

      if (!cancelled && this.isCurrent(record)) {
        const sessionError = toSessionError(error);
        this.updateSnapshot({ state: 'ERROR', error: sessionError, isCapturing: false });
      }

      if (error instanceof SessionRuntimeError) throw error;
      throw new SessionRuntimeError(
        toSessionError(error).code,
        toSessionError(error).message,
        toSessionError(error).retryable,
        toSessionError(error).fatal
      );
    }
  }

  private assertCurrent(record: SessionRecord, sessionId: string): void {
    if (
      record.cancelled ||
      record.generation !== this.lifecycleGeneration ||
      !this.isCurrent(record) ||
      this.snapshot.sessionId !== sessionId
    ) {
      throw new SessionCancelledError();
    }
  }

  private isCurrent(record: SessionRecord): boolean {
    return this.currentRecord === record;
  }

  private cleanupRecord(record: SessionRecord, reason: string): Promise<void> {
    if (!record.cleanupPromise) {
      record.cleanupPromise = this.runtime.stop(record.request, reason);
    }
    return record.cleanupPromise;
  }

  async stop(reason = 'user'): Promise<void> {
    if (this.pendingStart) {
      // STOP của người dùng phải hủy cả lượt START đang chờ thay thế phiên cũ.
      this.pendingStart.cancelled = true;
    }

    const record = this.currentRecord;
    if (!record) {
      if (this.snapshot.state !== 'IDLE') {
        this.updateSnapshot({
          state: 'IDLE',
          sessionId: null,
          tabId: null,
          error: null,
          isCapturing: false
        });
      }
      return;
    }

    if (record.stopPromise) return record.stopPromise;

    record.cancelled = true;
    record.controller.abort();
    ++this.lifecycleGeneration;
    this.updateSnapshot({ state: 'STOPPING', error: null, isCapturing: false });

    const stopPromise = (async () => {
      let cleanupError: SessionError | null = null;
      try {
        await this.cleanupRecord(record, reason);
      } catch (error) {
        cleanupError = toSessionError(error, 'CLEANUP_FAILED');
        console.error('[SessionManager] stop cleanup failed', JSON.stringify(cleanupError));
      }

      if (this.currentRecord === record) {
        this.currentRecord = null;
        if (cleanupError) {
          this.updateSnapshot({
            state: 'ERROR',
            sessionId: null,
            tabId: null,
            error: cleanupError,
            isCapturing: false
          });
        } else {
          this.updateSnapshot({
            state: 'IDLE',
            sessionId: null,
            tabId: null,
            error: null,
            isCapturing: false
          });
        }
      }

      if (cleanupError) {
        throw new SessionRuntimeError(
          cleanupError.code,
          cleanupError.message,
          cleanupError.retryable,
          cleanupError.fatal
        );
      }
    })();

    record.stopPromise = stopPromise;
    stopPromise.then(
      () => {
        if (record.stopPromise === stopPromise) record.stopPromise = null;
      },
      () => {
        if (record.stopPromise === stopPromise) record.stopPromise = null;
      }
    );
    return stopPromise;
  }

  async handleRuntimeEvent(event: SessionRuntimeEvent): Promise<void> {
    const record = this.currentRecord;
    if (!record || this.snapshot.sessionId !== event.sessionId || record.cancelled) return;

    if (event.error) {
      if (record.runtimeFailureHandled) return;
      record.runtimeFailureHandled = true;
      record.cancelled = true;
      record.controller.abort();
      ++this.lifecycleGeneration;
      const sessionError = toSessionError({
        code: event.error.code,
        message: event.error.message,
        retryable: event.error.retryable,
        fatal: event.error.fatal
      }, 'RUNTIME_ERROR');
      this.updateSnapshot({ state: 'ERROR', error: sessionError, isCapturing: false });
      await this.cleanupRecord(record, 'runtime-failure').catch((cleanupError) => {
        console.error('[SessionManager] runtime cleanup failed', JSON.stringify(toSessionError(cleanupError, 'CLEANUP_FAILED')));
      });
      return;
    }

    if (event.state === 'ACTIVE') {
      this.updateSnapshot({ state: 'ACTIVE', isCapturing: true, error: null });
    }
  }

  async updateMixer(config: Partial<AudioMixerConfig>): Promise<void> {
    const mixerConfig = {
      ...this.snapshot.mixerConfig,
      ...config
    };
    this.updateSnapshot({ mixerConfig });
    const record = this.currentRecord;
    if (record) {
      record.request.mixerConfig = cloneMixerConfig(mixerConfig);
      if (this.snapshot.state === 'ACTIVE' && this.runtime.updateMixer) {
        await this.runtime.updateMixer(record.request, mixerConfig);
      }
    }
  }

  async changeMode(mode: OperationMode): Promise<void> {
    this.updateSnapshot({ mode });
    const record = this.currentRecord;
    if (record) {
      record.request.mode = mode;
      if (this.snapshot.state === 'ACTIVE' && this.runtime.changeMode) {
        await this.runtime.changeMode(record.request, mode);
      }
    }
  }

  async forwardSeek(fromMs: number, toMs: number): Promise<void> {
    const record = this.currentRecord;
    if (record && this.snapshot.state === 'ACTIVE' && this.runtime.seek) {
      await this.runtime.seek(record.request, fromMs, toMs);
    }
  }

  async forwardVideoState(state: VideoPlaybackState): Promise<void> {
    const record = this.currentRecord;
    if (record && this.snapshot.state === 'ACTIVE' && this.runtime.videoState) {
      await this.runtime.videoState(record.request, state);
    }
  }

  private updateSnapshot(update: Partial<SessionSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      mixerConfig: update.mixerConfig ? cloneMixerConfig(update.mixerConfig) : cloneMixerConfig(this.snapshot.mixerConfig),
      isCapturing: update.state ? update.state === 'ACTIVE' : this.snapshot.isCapturing
    };
    try {
      this.onChange(this.getSnapshot());
    } catch (error) {
      console.error('[SessionManager] state notification failed', JSON.stringify(toSessionError(error, 'STATE_NOTIFY_FAILED')));
    }
  }
}
