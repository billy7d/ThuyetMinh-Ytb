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

// Ensure Offscreen Document is loaded
async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Real-time tab audio capture and mixing for Vietnamese dubbing'
    });
  }
}

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
      handleStartSession(msg.tabId, msg.mode, msg.mixerConfig)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_SESSION':
      handleStopSession()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'UPDATE_MIXER_CONFIG':
      currentMixerConfig = { ...currentMixerConfig, ...msg.config };
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'UPDATE_MIXER', config: currentMixerConfig });
      sendResponse({ success: true });
      return false;

    case 'CHANGE_MODE':
      currentMode = msg.mode;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'MODE_CHANGE', mode: msg.mode });
      sendResponse({ success: true });
      return false;

    // Relay messages from offscreen to content script
    case 'SUBTITLE_EVENT':
    case 'LATENCY_METRIC':
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, msg).catch(() => {});
      }
      return false;
  }
});

async function handleStartSession(
  tabId: number,
  mode: OperationMode = DEFAULT_MODE,
  mixerConfig?: Partial<AudioMixerConfig>
): Promise<void> {
  currentTabId = tabId;
  currentSessionId = `sess_${Date.now()}`;
  currentMode = mode;
  if (mixerConfig) currentMixerConfig = { ...currentMixerConfig, ...mixerConfig };

  await ensureOffscreenDocument();

  // Obtain Tab Media Stream ID
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Could not obtain tabCapture stream ID'));
      } else {
        resolve(id);
      }
    });
  });

  // Signal offscreen document to begin capture
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    sessionId: currentSessionId,
    mode: currentMode
  });

  if (res && res.error) {
    throw new Error(res.error);
  }

  isCapturing = true;
}

async function handleStopSession(): Promise<void> {
  if (!isCapturing) return;

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'STOP_CAPTURE'
  }).catch(() => {});

  isCapturing = false;
  currentSessionId = null;
  currentTabId = null;
}
