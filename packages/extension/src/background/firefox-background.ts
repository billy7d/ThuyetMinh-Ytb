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

interface ContentCommandResponse {
  success?: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
}

console.log('[BACKGROUND] Firefox background script loaded.');

function notifyPopup(message: unknown): void {
  try {
    const result = chrome.runtime.sendMessage({ target: 'popup', ...message as object });
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((error) => {
        console.debug('[BACKGROUND] popup notification skipped', JSON.stringify({ code: 'POPUP_NOT_OPEN', message: String(error) }));
      });
    }
  } catch (error) {
    console.debug('[BACKGROUND] popup notification failed', JSON.stringify({ code: 'POPUP_NOTIFY_FAILED', message: String(error) }));
  }
}

function sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: T) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new SessionRuntimeError('CONTENT_UNREACHABLE', runtimeError.message || 'Content script không phản hồi.', true, true));
        return;
      }
      resolve(response);
    });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SessionRuntimeError('SESSION_CANCELLED', 'Phiên khởi tạo đã bị hủy.', false, false);
  }
}

function classifyContentError(error: unknown, fallbackMessage: string): SessionRuntimeError {
  const sessionError = toSessionError(error, 'CONTENT_UNREACHABLE');
  const lower = sessionError.message.toLowerCase();
  if (lower.includes('permission') || lower.includes('not allowed') || lower.includes('cannot access') || lower.includes('restricted')) {
    return new SessionRuntimeError('PERMISSION_DENIED', sessionError.message, false, true);
  }
  return new SessionRuntimeError(sessionError.code, sessionError.message || fallbackMessage, sessionError.retryable, sessionError.fatal);
}

async function pingContentScript(tabId: number): Promise<ContentPingResponse> {
  try {
    return await sendTabMessage<ContentPingResponse>(tabId, { type: 'CONTENT_PING' });
  } catch (error) {
    throw classifyContentError(error, 'Content script không phản hồi.');
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  const scripting = (chrome as any).scripting;
  try {
    if (scripting?.executeScript) {
      await scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      return;
    }
    const executeScript = (chrome.tabs as any).executeScript;
    if (executeScript) {
      await executeScript.call(chrome.tabs, tabId, { file: 'content/content.js' });
      return;
    }
    throw new SessionRuntimeError('INJECTION_UNSUPPORTED', 'Firefox không hỗ trợ API nạp content script.', false, true);
  } catch (error) {
    throw classifyContentError(error, 'Không thể nạp content script vào tab.');
  }
}

const contentHandshake = new ContentScriptHandshake({
  ping: pingContentScript,
  inject: injectContentScript
});

const runtime: SessionRuntime = {
  ensureReady: (tabId, signal) => contentHandshake.ensureReady(tabId, signal),

  async start(request: SessionStartRequest & { sessionId: string }, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let response: ContentCommandResponse;
    try {
      response = await sendTabMessage<ContentCommandResponse>(request.tabId, {
        type: 'FIREFOX_START_CAPTURE',
        sessionId: request.sessionId,
        mode: request.mode,
        mixerConfig: request.mixerConfig,
        wsUrl: request.wsUrl
      });
    } catch (error) {
      throw classifyContentError(error, 'Không thể bắt đầu phiên Firefox.');
    }
    if (!response?.success) {
      const message = response?.error || 'Không thể bắt đầu phiên Firefox.';
      const lower = message.toLowerCase();
      const code = response?.code ||
        (lower.includes('video') ? 'VIDEO_NOT_FOUND' :
          lower.includes('permission') || lower.includes('notallowed') ? 'PERMISSION_DENIED' : 'FIREFOX_START_FAILED');
      const retryable = response?.retryable === true || code === 'WS_CONNECTION_TIMEOUT';
      throw new SessionRuntimeError(code, message, retryable, true);
    }
  },

  async stop(request: SessionStartRequest, reason: string): Promise<void> {
    if (!request.sessionId) return;
    try {
      const response = await sendTabMessage<ContentCommandResponse>(request.tabId, {
        type: 'FIREFOX_STOP_CAPTURE',
        sessionId: request.sessionId,
        reason
      });
      if (response && response.success === false) {
        throw new SessionRuntimeError('CONTENT_STOP_FAILED', response.error || 'Content script không dừng được phiên.', false, true);
      }
    } catch (error) {
      const normalized = toSessionError(error, 'CONTENT_STOP_FAILED');
      if (normalized.code === 'CONTENT_UNREACHABLE' || normalized.code === 'TAB_CLOSED') {
        console.debug('[BACKGROUND] content already gone during cleanup', JSON.stringify(normalized));
        return;
      }
      throw error;
    }
  },

  async updateMixer(request: SessionStartRequest, config: AudioMixerConfig): Promise<void> {
    const response = await sendTabMessage<ContentCommandResponse>(request.tabId, {
      type: 'FIREFOX_UPDATE_MIXER',
      sessionId: request.sessionId,
      config
    });
    if (response && response.success === false) {
      throw new SessionRuntimeError('MIXER_UPDATE_FAILED', response.error || 'Không thể cập nhật bộ trộn âm thanh.', true, false);
    }
  },

  async changeMode(request: SessionStartRequest, mode: OperationMode): Promise<void> {
    const response = await sendTabMessage<ContentCommandResponse>(request.tabId, {
      type: 'FIREFOX_CHANGE_MODE',
      sessionId: request.sessionId,
      mode
    });
    if (response && response.success === false) {
      throw new SessionRuntimeError('MODE_CHANGE_FAILED', response.error || 'Không thể đổi chế độ.', true, false);
    }
  }
};

const sessionManager = new SessionManager('fx', runtime, (snapshot: SessionSnapshot) => {
  notifyPopup({ type: 'SESSION_STATE', ...snapshot });
});

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_STATUS':
      sendResponse(sessionManager.getSnapshot());
      return false;

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

    case 'SESSION_RUNTIME':
      if (msg.sessionId) {
        void sessionManager.handleRuntimeEvent({
          sessionId: msg.sessionId,
          state: msg.state,
          error: msg.error
        });
      }
      sendResponse({ success: true });
      return false;

    case 'LATENCY_METRIC':
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

    case 'VIDEO_STATE_UPDATE':
      void sessionManager.forwardVideoState(msg.state as VideoPlaybackState).catch((error) => {
        console.warn('[BACKGROUND] video state relay failed', JSON.stringify(toSessionError(error, 'VIDEO_STATE_RELAY_FAILED')));
      });
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sessionManager.getSnapshot().tabId) {
    void sessionManager.stop('tab-removed').catch((error) => {
      console.error('[BACKGROUND] tab cleanup failed', JSON.stringify(toSessionError(error, 'TAB_CLEANUP_FAILED')));
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === sessionManager.getSnapshot().tabId && (changeInfo.url || changeInfo.status === 'loading')) {
    void sessionManager.stop('tab-navigation').catch((error) => {
      console.error('[BACKGROUND] navigation cleanup failed', JSON.stringify(toSessionError(error, 'NAVIGATION_CLEANUP_FAILED')));
    });
  }
});
