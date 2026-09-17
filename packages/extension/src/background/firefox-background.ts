import { OperationMode, AudioMixerConfig, DEFAULT_MODE, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME } from '@vietdub/shared';

let currentTabId: number | null = null;
let currentSessionId: string | null = null;
let isCapturing = false;
let currentMode: OperationMode = DEFAULT_MODE;
let currentMixerConfig: AudioMixerConfig = {
  originalVolume: DEFAULT_ORIGINAL_VOLUME,
  originalMuted: false,
  ttsVolume: DEFAULT_TTS_VOLUME
};

console.log('[BACKGROUND] Firefox Background script loaded and listening.');

// Listen for tab closure or navigation to cleanup session
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId && isCapturing) {
    console.log(`[BACKGROUND] Active tab ${tabId} closed, cleaning up session.`);
    cleanupSession();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && isCapturing && changeInfo.url) {
    console.log(`[BACKGROUND] Active tab ${tabId} navigated to ${changeInfo.url}, stopping session.`);
    cleanupSession();
  }
});

function cleanupSession(): void {
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { type: 'FIREFOX_STOP_CAPTURE' }).catch(() => {});
  }
  isCapturing = false;
  currentSessionId = null;
  currentTabId = null;
}

// Handshake helper: Ping content script and auto-inject if receiver is missing
async function ensureContentScriptReady(tabId: number): Promise<boolean> {
  // Try pinging first
  const pingOk = await new Promise<boolean>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' }, (res) => {
      if (chrome.runtime.lastError || !res?.ready) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });

  if (pingOk) {
    console.log(`[BACKGROUND] Content script already ready in tab ${tabId}.`);
    return true;
  }

  // Not ready, attempt injection
  console.log(`[BACKGROUND] Content script not responding in tab ${tabId}, attempting injection...`);
  try {
    const scripting = (chrome as any).scripting;
    if (scripting?.executeScript) {
      await scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      });
    } else if ((chrome.tabs as any).executeScript) {
      await new Promise<void>((resolve, reject) => {
        (chrome.tabs as any).executeScript(tabId, { file: 'content/content.js' }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    }
  } catch (injectErr: any) {
    console.warn('[BACKGROUND] Injection error:', injectErr.message);
    return false;
  }

  // Verify ping again after injection
  await new Promise((r) => setTimeout(r, 250));
  return new Promise<boolean>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' }, (res) => {
      if (chrome.runtime.lastError || !res?.ready) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_STATUS': {
      sendResponse({
        isCapturing,
        sessionId: currentSessionId,
        mode: currentMode,
        mixerConfig: currentMixerConfig,
        tabId: currentTabId
      });
      return false;
    }

    case 'START_SESSION': {
      console.log(`[BACKGROUND] Received START_SESSION request for tab ${msg.tabId}`);
      if (isCapturing && currentTabId && currentTabId !== msg.tabId) {
        // Stop previous tab session
        cleanupSession();
      }

      currentTabId = msg.tabId;
      currentSessionId = `sess_fx_${Date.now()}`;
      currentMode = msg.mode || DEFAULT_MODE;
      if (msg.mixerConfig) currentMixerConfig = { ...currentMixerConfig, ...msg.mixerConfig };

      (async () => {
        // Step 1: Handshake with content script
        const ready = await ensureContentScriptReady(msg.tabId);
        if (!ready) {
          sendResponse({
            success: false,
            error: 'Không thể kết nối với trang video. Hãy thử tải lại trang (F5) để kích hoạt tiện ích.'
          });
          return;
        }

        // Step 2: Send START_CAPTURE to content script
        console.log(`[BACKGROUND] Dispatching FIREFOX_START_CAPTURE for session ${currentSessionId}`);
        chrome.tabs.sendMessage(
          msg.tabId,
          {
            type: 'FIREFOX_START_CAPTURE',
            sessionId: currentSessionId,
            mode: currentMode,
            mixerConfig: currentMixerConfig
          },
          (res) => {
            if (chrome.runtime.lastError || !res?.success) {
              const errorMsg = res?.error || chrome.runtime.lastError?.message || 'Khởi tạo luồng âm thanh thất bại.';
              console.error(`[BACKGROUND] FIREFOX_START_CAPTURE failed:`, errorMsg);
              isCapturing = false;
              sendResponse({ success: false, error: errorMsg });
            } else {
              console.log(`[BACKGROUND] Session ${currentSessionId} is now ACTIVE!`);
              isCapturing = true;
              sendResponse({ success: true });
            }
          }
        );
      })();

      return true; // Keep message channel open for async response
    }

    case 'STOP_SESSION': {
      console.log(`[BACKGROUND] Received STOP_SESSION request.`);
      cleanupSession();
      sendResponse({ success: true });
      return false;
    }

    case 'UPDATE_MIXER_CONFIG': {
      currentMixerConfig = { ...currentMixerConfig, ...msg.config };
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'FIREFOX_UPDATE_MIXER',
          config: currentMixerConfig
        }).catch(() => {});
      }
      sendResponse({ success: true });
      return false;
    }

    case 'CHANGE_MODE': {
      currentMode = msg.mode;
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'FIREFOX_CHANGE_MODE',
          mode: msg.mode
        }).catch(() => {});
      }
      sendResponse({ success: true });
      return false;
    }

    default:
      return false;
  }
});
