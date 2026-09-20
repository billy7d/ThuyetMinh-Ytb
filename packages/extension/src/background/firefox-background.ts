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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_STATUS':
      sendResponse({
        isCapturing,
        sessionId: currentSessionId,
        mode: currentMode,
        mixerConfig: currentMixerConfig,
        tabId: currentTabId
      });
      return false;

    case 'START_SESSION':
      currentTabId = msg.tabId;
      currentSessionId = `sess_fx_${Date.now()}`;
      currentMode = msg.mode || DEFAULT_MODE;
      if (msg.mixerConfig) currentMixerConfig = { ...currentMixerConfig, ...msg.mixerConfig };

      const sendStartToTab = (retryCount = 1) => {
        chrome.tabs.sendMessage(msg.tabId, {
          type: 'FIREFOX_START_CAPTURE',
          sessionId: currentSessionId,
          mode: currentMode,
          mixerConfig: currentMixerConfig
        }, (res) => {
          if (chrome.runtime.lastError || !res?.success) {
            if (retryCount === 1) {
              const scripting = (chrome as any).scripting;
              if (scripting?.executeScript) {
                scripting.executeScript({
                  target: { tabId: msg.tabId },
                  files: ['content/content.js']
                }).then(() => {
                  setTimeout(() => sendStartToTab(0), 400);
                }).catch((err: any) => {
                  sendResponse({ success: false, error: err.message });
                });
                return;
              }
            }
            sendResponse({
              success: false,
              error: res?.error || chrome.runtime.lastError?.message || 'Không thể kết nối với phần tử video. Vui lòng thử tải lại trang (F5).'
            });
          } else {
            isCapturing = true;
            sendResponse({ success: true });
          }
        });
      };

      sendStartToTab(1);
      return true;

    case 'STOP_SESSION':
      if (currentTabId !== null) {
        chrome.tabs.sendMessage(currentTabId, { type: 'FIREFOX_STOP_CAPTURE' }).catch(() => {});
      }
      isCapturing = false;
      currentSessionId = null;
      currentTabId = null;
      sendResponse({ success: true });
      return false;

    case 'UPDATE_MIXER_CONFIG':
      currentMixerConfig = { ...currentMixerConfig, ...msg.config };
      if (currentTabId !== null) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'FIREFOX_UPDATE_MIXER',
          config: currentMixerConfig
        }).catch(() => {});
      }
      sendResponse({ success: true });
      return false;

    case 'CHANGE_MODE':
      currentMode = msg.mode;
      if (currentTabId !== null) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'FIREFOX_CHANGE_MODE',
          mode: msg.mode
        }).catch(() => {});
      }
      sendResponse({ success: true });
      return false;
  }
});
