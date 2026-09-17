import {
  AudioMixerConfig,
  DEFAULT_MODE,
  DEFAULT_ORIGINAL_VOLUME,
  DEFAULT_TTS_VOLUME,
  OperationMode,
  VideoPlaybackState
} from '@vietdub/shared';
import {
  SessionManager,
  SessionRuntime,
  SessionRuntimeError,
  SessionSnapshot,
  SessionStartRequest,
  toSessionError
} from './session-manager.js';
import { ContentPingResponse, ContentScriptHandshake } from './content-handshake.js';

interface RuntimeResponse {
  success?: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
}

let offscreenReadyPromise: Promise<void> | null = null;

console.log('[CHROME-BACKGROUND] Chrome service worker loaded.');

function notifyPopup(message: unknown): void {
  try {
    const result = chrome.runtime.sendMessage({ target: 'popup', ...message as object });
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((error) => {
        console.debug('[CHROME-BACKGROUND] popup notification skipped', JSON.stringify({ code: 'POPUP_NOT_OPEN', message: String(error) }));
      });
    }
  } catch (error) {
    console.debug('[CHROME-BACKGROUND] popup notification failed', JSON.stringify({ code: 'POPUP_NOTIFY_FAILED', message: String(error) }));
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SessionRuntimeError('SESSION_CANCELLED', 'Phiên khởi tạo đã bị hủy.', false, false);
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReadyPromise) return offscreenReadyPromise;

  offscreenReadyPromise = (async () => {
    const runtimeApi = chrome.runtime as any;
    if (!runtimeApi.getContexts || !chrome.offscreen?.createDocument) {
      throw new SessionRuntimeError('OFFSCREEN_UNSUPPORTED', 'Chrome không hỗ trợ Offscreen Document.', false, true);
    }

    const offscreenUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');
    const existingContexts = await runtimeApi.getContexts({
      contextTypes: [runtimeApi.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl]
    });

    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: offscreenUrl,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Real-time tab audio capture and mixing for Vietnamese dubbing'
      });
    }
  })();

  offscreenReadyPromise.then(
    () => {},
    () => {
      offscreenReadyPromise = null;
    }
  );
  return offscreenReadyPromise;
}

async function sendOffscreen<T = RuntimeResponse>(message: unknown): Promise<T> {
  try {
    const response = await chrome.runtime.sendMessage(message) as T;
    return response;
  } catch (error) {
    throw new SessionRuntimeError('OFFSCREEN_UNREACHABLE', String(error), true, true);
  }
}

async function sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message) as T;
  } catch (error) {
    throw new SessionRuntimeError('CONTENT_UNREACHABLE', String(error), true, true);
  }
}

async function pingContentScript(tabId: number): Promise<ContentPingResponse> {
  return sendTabMessage<ContentPingResponse>(tabId, { type: 'CONTENT_PING' });
}

function classifyContentError(error: unknown): SessionRuntimeError {
  const sessionError = toSessionError(error, 'INJECTION_FAILED');
  const lower = sessionError.message.toLowerCase();
  const code = lower.includes('permission') || lower.includes('not allowed') || lower.includes('cannot access') || lower.includes('restricted')
    ? 'PERMISSION_DENIED'
    : sessionError.code;
  return new SessionRuntimeError(code, sessionError.message || 'Không thể nạp content script vào tab.', sessionError.retryable, sessionError.fatal);
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    const scripting = (chrome as any).scripting;
    if (scripting?.executeScript) {
      await scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      return;
    }

    const executeScript = (chrome.tabs as any).executeScript;
    if (executeScript) {
      await new Promise<void>((resolve, reject) => {
        executeScript.call(chrome.tabs, tabId, { file: 'content/content.js' }, () => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) reject(new SessionRuntimeError('INJECTION_FAILED', runtimeError.message || 'Chrome không nạp được content script.', false, true));
          else resolve();
        });
      });
      return;
    }

    throw new SessionRuntimeError('INJECTION_UNSUPPORTED', 'Chrome không hỗ trợ API nạp content script.', false, true);
  } catch (error) {
    throw classifyContentError(error);
  }
}

const contentHandshake = new ContentScriptHandshake({
  ping: pingContentScript,
  inject: injectContentScript
});

async function getTabCaptureStreamId(tabId: number, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !streamId) {
        const message = runtimeError?.message || 'Chrome không cấp được stream âm thanh của tab.';
        const lower = message.toLowerCase();
        const code = lower.includes('permission') || lower.includes('not allowed') ? 'PERMISSION_DENIED' : 'TAB_CAPTURE_FAILED';
        reject(new SessionRuntimeError(code, message, false, true));
        return;
      }
      resolve(streamId);
    });
  });
}

const runtime: SessionRuntime = {
  async ensureReady(tabId: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await contentHandshake.ensureReady(tabId, signal);
    const contentState = await pingContentScript(tabId);
    if (!contentState?.hasVideo) {
      throw new SessionRuntimeError('VIDEO_NOT_FOUND', 'Chưa tìm thấy phần tử video trên tab hiện tại.', false, true);
    }
    await ensureOffscreenDocument();
    throwIfAborted(signal);
  },

  async start(request: SessionStartRequest & { sessionId: string }, signal: AbortSignal): Promise<void> {
    await ensureOffscreenDocument();
    const streamId = await getTabCaptureStreamId(request.tabId, signal);
    throwIfAborted(signal);
    const response = await sendOffscreen<RuntimeResponse>({
      target: 'offscreen',
      type: 'START_CAPTURE',
      streamId,
      sessionId: request.sessionId,
      mode: request.mode,
      mixerConfig: request.mixerConfig,
      wsUrl: request.wsUrl
    });
    if (!response?.success) {
      throw new SessionRuntimeError(
        response?.code || 'CHROME_START_FAILED',
        response?.error || 'Chrome không thể khởi tạo phiên.',
        response?.retryable === true,
        true
      );
    }
  },

  async stop(request: SessionStartRequest, reason: string): Promise<void> {
    if (!request.sessionId) return;
    try {
      const response = await sendOffscreen<RuntimeResponse>({
        target: 'offscreen',
        type: 'STOP_CAPTURE',
        sessionId: request.sessionId,
        reason
      });
      if (response && response.success === false) {
        throw new SessionRuntimeError('OFFSCREEN_STOP_FAILED', response.error || 'Offscreen không dừng được phiên.', false, true);
      }
    } catch (error) {
      const normalized = toSessionError(error, 'OFFSCREEN_STOP_FAILED');
      if (normalized.code === 'OFFSCREEN_UNREACHABLE') {
        console.debug('[CHROME-BACKGROUND] offscreen already gone during cleanup', JSON.stringify(normalized));
        return;
      }
      throw error;
    }
  },

  async updateMixer(_request: SessionStartRequest, config: AudioMixerConfig): Promise<void> {
    const response = await sendOffscreen<RuntimeResponse>({ target: 'offscreen', type: 'UPDATE_MIXER', config });
    if (response && response.success === false) {
      throw new SessionRuntimeError('MIXER_UPDATE_FAILED', response.error || 'Không thể cập nhật bộ trộn âm thanh.', true, false);
    }
  },

  async changeMode(_request: SessionStartRequest, mode: OperationMode): Promise<void> {
    const response = await sendOffscreen<RuntimeResponse>({ target: 'offscreen', type: 'MODE_CHANGE', mode });
    if (response && response.success === false) {
      throw new SessionRuntimeError('MODE_CHANGE_FAILED', response.error || 'Không thể đổi chế độ.', true, false);
    }
  },

  async seek(request: SessionStartRequest, fromMs: number, toMs: number): Promise<void> {
    await sendOffscreen({ target: 'offscreen', type: 'SEEK_EVENT', sessionId: request.sessionId, fromMs, toMs });
  },

  async videoState(request: SessionStartRequest, state: VideoPlaybackState): Promise<void> {
    await sendOffscreen({ target: 'offscreen', type: 'VIDEO_STATE_UPDATE', sessionId: request.sessionId, state });
  }
};

const sessionManager = new SessionManager('chrome', runtime, (snapshot: SessionSnapshot) => {
  notifyPopup({ type: 'SESSION_STATE', ...snapshot });
});

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_STATUS':
      sendResponse(sessionManager.getSnapshot());
      return false;

    case 'GET_OFFSCREEN_STATUS':
      sendOffscreen<Record<string, unknown>>({ target: 'offscreen', type: 'GET_STATUS' }).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ active: false, error: toSessionError(error, 'OFFSCREEN_STATUS_FAILED').message })
      );
      return true;

    case 'START_SESSION': {
      const tabId = Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id;
      if (!Number.isInteger(tabId)) {
        sendResponse({ success: false, code: 'INVALID_TAB', error: 'Không xác định được tab video.' });
        return false;
      }
      const request: SessionStartRequest = {
        tabId,
        mode: msg.mode || DEFAULT_MODE,
        mixerConfig: {
          originalVolume: Number.isFinite(msg.mixerConfig?.originalVolume) ? msg.mixerConfig.originalVolume : DEFAULT_ORIGINAL_VOLUME,
          originalMuted: msg.mixerConfig?.originalMuted === true,
          ttsVolume: Number.isFinite(msg.mixerConfig?.ttsVolume) ? msg.mixerConfig.ttsVolume : DEFAULT_TTS_VOLUME
        },
        wsUrl: msg.wsUrl
      };
      sessionManager.start(request)
        .then(() => sendResponse({ success: true, sessionId: sessionManager.getSnapshot().sessionId }))
        .catch((error) => {
          const sessionError = toSessionError(error);
          sendResponse({ success: false, code: sessionError.code, error: sessionError.message, retryable: sessionError.retryable });
        });
      return true;
    }

    case 'STOP_SESSION':
      sessionManager.stop('user').then(
        () => sendResponse({ success: true }),
        (error) => {
          const sessionError = toSessionError(error, 'STOP_FAILED');
          sendResponse({ success: false, code: sessionError.code, error: sessionError.message });
        }
      );
      return true;

    case 'UPDATE_MIXER_CONFIG':
      sessionManager.updateMixer(msg.config || {}).then(
        () => sendResponse({ success: true }),
        (error) => {
          const sessionError = toSessionError(error, 'MIXER_UPDATE_FAILED');
          sendResponse({ success: false, code: sessionError.code, error: sessionError.message });
        }
      );
      return true;

    case 'CHANGE_MODE':
      sessionManager.changeMode(msg.mode).then(
        () => sendResponse({ success: true }),
        (error) => {
          const sessionError = toSessionError(error, 'MODE_CHANGE_FAILED');
          sendResponse({ success: false, code: sessionError.code, error: sessionError.message });
        }
      );
      return true;

    case 'SEEK_EVENT':
      void sessionManager.forwardSeek(Number(msg.fromMs) || 0, Number(msg.toMs) || 0).catch((error) => {
        console.warn('[CHROME-BACKGROUND] seek relay failed', JSON.stringify(toSessionError(error, 'SEEK_RELAY_FAILED')));
      });
      sendResponse({ success: true });
      return false;

    case 'VIDEO_STATE_UPDATE':
      void sessionManager.forwardVideoState(msg.state as VideoPlaybackState).catch((error) => {
        console.warn('[CHROME-BACKGROUND] video state relay failed', JSON.stringify(toSessionError(error, 'VIDEO_STATE_RELAY_FAILED')));
      });
      sendResponse({ success: true });
      return false;

    case 'SESSION_RUNTIME':
      if (msg.sessionId) {
        void sessionManager.handleRuntimeEvent({ sessionId: msg.sessionId, state: msg.state, error: msg.error });
      }
      sendResponse({ success: true });
      return false;

    case 'SUBTITLE_EVENT':
      if (msg.sessionId === sessionManager.getSnapshot().sessionId && sessionManager.getSnapshot().tabId !== null) {
        void sendTabMessage(sessionManager.getSnapshot().tabId as number, msg).catch((error) => {
          console.debug('[CHROME-BACKGROUND] subtitle relay skipped', JSON.stringify(toSessionError(error, 'SUBTITLE_RELAY_FAILED')));
        });
      }
      sendResponse({ success: true });
      return false;

    case 'LATENCY_METRIC':
    case 'SESSION_METRICS':
      if (msg.sessionId === sessionManager.getSnapshot().sessionId) notifyPopup(msg);
      sendResponse({ success: true });
      return false;

    case 'ERROR':
      if (msg.sessionId === sessionManager.getSnapshot().sessionId) {
        void sessionManager.handleRuntimeEvent({
          sessionId: msg.sessionId,
          error: { code: msg.code, message: msg.message, retryable: false, fatal: msg.fatal }
        });
      }
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sessionManager.getSnapshot().tabId) {
    void sessionManager.stop('tab-removed').catch((error) => {
      console.error('[CHROME-BACKGROUND] tab cleanup failed', JSON.stringify(toSessionError(error, 'TAB_CLEANUP_FAILED')));
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === sessionManager.getSnapshot().tabId && (changeInfo.url || changeInfo.status === 'loading')) {
    void sessionManager.stop('tab-navigation').catch((error) => {
      console.error('[CHROME-BACKGROUND] navigation cleanup failed', JSON.stringify(toSessionError(error, 'NAVIGATION_CLEANUP_FAILED')));
    });
  }
});
