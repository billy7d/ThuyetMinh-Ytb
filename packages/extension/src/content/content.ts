import { SubtitleRenderer } from './subtitle-renderer.js';
import { VideoSyncController } from '../sync/video-sync.js';
import { AudioMixer } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import { ClientMessage, ServerMessage, OperationMode, AudioMixerConfig } from '@vietdub/shared';

let activeVideo: HTMLVideoElement | null = null;
let subtitleRenderer: SubtitleRenderer | null = null;
let syncController: VideoSyncController | null = null;

// Firefox-specific audio context & mixer state
let fxAudioCtx: AudioContext | null = null;
let fxAudioMixer: AudioMixer | null = null;
let fxPcmProcessor: PCMProcessor | null = null;
let fxWs: WebSocket | null = null;
let fxSessionId: string | null = null;
let fxCurrentGeneration: number = 1;

function findVideoElement(): HTMLVideoElement | null {
  // 1. YouTube-specific main video selectors
  const ytVideo = document.querySelector<HTMLVideoElement>(
    'video.html5-main-video, #movie_player video, .html5-video-player video'
  );
  if (ytVideo) return ytVideo;

  // 2. Generic HTML5 videos
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  if (videos.length === 0) return null;

  // 3. Prefer currently playing video
  const playing = videos.find(v => !v.paused && v.currentTime > 0);
  if (playing) return playing;

  // 4. Prefer video with valid src or srcObject
  const withSrc = videos.find(v => !!v.src || !!v.srcObject || v.readyState > 0);
  if (withSrc) return withSrc;

  // 5. Fallback to largest video element
  return videos.sort((a, b) => {
    const aArea = (a.clientWidth || a.videoWidth || 1) * (a.clientHeight || a.videoHeight || 1);
    const bArea = (b.clientWidth || b.videoWidth || 1) * (b.clientHeight || b.videoHeight || 1);
    return bArea - aArea;
  })[0];
}

function initVideoIntegration(): boolean {
  const video = findVideoElement();
  if (!video) return false;

  activeVideo = video;

  if (!subtitleRenderer) {
    subtitleRenderer = new SubtitleRenderer();
  }
  subtitleRenderer.attachToVideo(video);

  if (!syncController) {
    syncController = new VideoSyncController(video, {
      onStateChange: (state) => {
        chrome.runtime.sendMessage({ type: 'VIDEO_STATE_UPDATE', state }).catch(() => {});
      },
      onSeek: (fromMs, toMs) => {
        chrome.runtime.sendMessage({ type: 'SEEK_EVENT', fromMs, toMs }).catch(() => {});
        if (fxWs && fxWs.readyState === WebSocket.OPEN && fxSessionId) {
          fxCurrentGeneration++;
          fxWs.send(JSON.stringify({
            type: 'SEEK_EVENT',
            sessionId: fxSessionId,
            timestamp: Date.now(),
            fromMs,
            toMs,
            generation: fxCurrentGeneration
          }));
        }
      },
      onPause: () => {
        if (fxAudioMixer) {
          syncController?.stopActiveTTS();
        }
      },
      onResume: () => {}
    });
  }

  return true;
}

// Listen for messages from background/popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'CHECK_VIDEO':
      const video = findVideoElement();
      sendResponse({
        hasVideo: !!video,
        videoTitle: document.title,
        currentTime: video?.currentTime || 0,
        paused: video?.paused ?? true
      });
      return false;

    case 'SUBTITLE_EVENT':
      if (subtitleRenderer && msg.text) {
        subtitleRenderer.showSubtitle(msg.segmentId, msg.text, (msg.endMs - msg.startMs) || 4000);
      }
      return false;

    // Firefox Direct Audio Capture Handling
    case 'FIREFOX_START_CAPTURE':
      handleFirefoxStartCapture(msg.sessionId, msg.mode, msg.mixerConfig)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'FIREFOX_STOP_CAPTURE':
      handleFirefoxStopCapture();
      sendResponse({ success: true });
      return false;

    case 'FIREFOX_UPDATE_MIXER':
      if (fxAudioMixer) {
        if (msg.config.originalVolume !== undefined) fxAudioMixer.setOriginalVolume(msg.config.originalVolume);
        if (msg.config.originalMuted !== undefined) fxAudioMixer.setOriginalMuted(msg.config.originalMuted);
        if (msg.config.ttsVolume !== undefined) fxAudioMixer.setTTSVolume(msg.config.ttsVolume);
      }
      sendResponse({ success: true });
      return false;

    case 'FIREFOX_CHANGE_MODE':
      if (fxWs && fxWs.readyState === WebSocket.OPEN && fxSessionId) {
        fxWs.send(JSON.stringify({
          type: 'MODE_CHANGE',
          sessionId: fxSessionId,
          timestamp: Date.now(),
          mode: msg.mode
        }));
      }
      sendResponse({ success: true });
      return false;
  }
});

async function handleFirefoxStartCapture(
  sessionId: string,
  mode: OperationMode,
  mixerConfig?: Partial<AudioMixerConfig>,
  wsUrl = 'ws://localhost:8080'
): Promise<void> {
  const video = findVideoElement();
  if (!video) throw new Error('Không tìm thấy phần tử video trên trang');

  initVideoIntegration();
  fxSessionId = sessionId;

  fxAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  let sourceNode: MediaElementAudioSourceNode | MediaStreamAudioSourceNode;

  if (video.captureStream || (video as any).mozCaptureStream) {
    const stream = (video.captureStream || (video as any).mozCaptureStream).call(video);
    sourceNode = fxAudioCtx.createMediaStreamSource(stream);
  } else {
    sourceNode = fxAudioCtx.createMediaElementSource(video);
  }

  fxAudioMixer = new AudioMixer(fxAudioCtx, sourceNode);
  if (mixerConfig) {
    if (mixerConfig.originalVolume !== undefined) fxAudioMixer.setOriginalVolume(mixerConfig.originalVolume);
    if (mixerConfig.originalMuted !== undefined) fxAudioMixer.setOriginalMuted(mixerConfig.originalMuted);
    if (mixerConfig.ttsVolume !== undefined) fxAudioMixer.setTTSVolume(mixerConfig.ttsVolume);
  }

  fxWs = new WebSocket(wsUrl);
  fxWs.onopen = () => {
    const startMsg: ClientMessage = {
      type: 'SESSION_START',
      sessionId,
      timestamp: Date.now(),
      mode,
      audioSampleRate: 16000
    };
    fxWs?.send(JSON.stringify(startMsg));
  };

  fxWs.onmessage = async (event) => {
    try {
      const serverMsg = JSON.parse(event.data) as ServerMessage;
      if (serverMsg.type === 'SUBTITLE_EVENT' && subtitleRenderer) {
        subtitleRenderer.showSubtitle(serverMsg.segmentId, serverMsg.text, 4000);
      }
      if (serverMsg.type === 'TTS_CHUNK') {
        if (serverMsg.generation === fxCurrentGeneration && fxAudioCtx && fxAudioMixer) {
          const binary = atob(serverMsg.audioBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const buffer = await fxAudioCtx.decodeAudioData(bytes.buffer);
          const source = fxAudioMixer.playTTSBuffer(buffer);
          syncController?.setActiveTTSSource(source);
        }
      }
    } catch (err) {
      console.error('[Firefox Content] WS message error:', err);
    }
  };

  fxPcmProcessor = new PCMProcessor(
    fxAudioCtx,
    fxAudioMixer.getSTTTapNode(),
    (pcmBase64, timestampMs) => {
      if (fxWs && fxWs.readyState === WebSocket.OPEN) {
        const chunkMsg: ClientMessage = {
          type: 'AUDIO_CHUNK',
          sessionId,
          timestamp: Date.now(),
          sequence: 0,
          pcmBase64,
          timestampMs
        };
        fxWs.send(JSON.stringify(chunkMsg));
      }
    }
  );
}

function handleFirefoxStopCapture(): void {
  if (fxPcmProcessor) {
    fxPcmProcessor.stop();
    fxPcmProcessor = null;
  }
  if (fxAudioMixer) {
    fxAudioMixer.disconnect();
    fxAudioMixer = null;
  }
  if (fxAudioCtx) {
    fxAudioCtx.close();
    fxAudioCtx = null;
  }
  if (fxWs) {
    if (fxWs.readyState === WebSocket.OPEN && fxSessionId) {
      fxWs.send(JSON.stringify({
        type: 'SESSION_STOP',
        sessionId: fxSessionId,
        timestamp: Date.now()
      }));
    }
    fxWs.close();
    fxWs = null;
  }
  fxSessionId = null;
}

// Automatically detect video on load, SPA navigation or DOM mutations
window.addEventListener('DOMContentLoaded', () => initVideoIntegration());
window.addEventListener('load', () => initVideoIntegration());
window.addEventListener('yt-navigate-finish', () => initVideoIntegration());

const observer = new MutationObserver(() => {
  if (!activeVideo || !document.contains(activeVideo)) {
    initVideoIntegration();
  }
});
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}
