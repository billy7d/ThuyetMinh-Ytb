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
let fxSequence = 0;
let fxPlaybackEpoch = 1;
let fxRestoreState: { video: HTMLVideoElement; muted: boolean; volume: number } | null = null;
let contentGeneration = 1;

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

  if (activeVideo && activeVideo !== video) {
    chrome.runtime.sendMessage({ type: 'VIDEO_CHANGED' }).catch(() => {});
    handleFirefoxStopCapture();
    syncController?.destroy();
    syncController = null;
    subtitleRenderer?.detach();
  }

  activeVideo = video;
  contentGeneration = 1;

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
        contentGeneration++;
        subtitleRenderer?.invalidateGeneration(contentGeneration);
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
        fxPlaybackEpoch++;
        fxAudioMixer?.stopTTS();
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
        subtitleRenderer.showSubtitle(
          msg.segmentId,
          msg.text,
          (msg.endMs - msg.startMs) || 4000,
          msg.generation || 0
        );
      }
      return false;

    case 'ERROR':
      if (msg.fatal) subtitleRenderer?.hideSubtitle();
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
  if (fxWs || fxAudioCtx || fxAudioMixer) handleFirefoxStopCapture();
  fxSessionId = sessionId;
  fxCurrentGeneration = 1;
  fxPlaybackEpoch++;
  contentGeneration = 1;
  fxSequence = 0;
  fxRestoreState = { video, muted: video.muted, volume: video.volume };
  // captureStream keeps the media element audible, so mute the native path
  // while the mixer owns the only speaker path. The original value is restored
  // on every stop/error/navigation path.
  fxAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  let sourceNode: MediaElementAudioSourceNode | MediaStreamAudioSourceNode;

  const captureStream = (video as any).captureStream || (video as any).mozCaptureStream;
  if (captureStream) {
    const stream = captureStream.call(video);
    sourceNode = fxAudioCtx.createMediaStreamSource(stream);
  } else {
    sourceNode = fxAudioCtx.createMediaElementSource(video);
  }
  video.muted = true;

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

  fxWs.onerror = () => {
    if (fxSessionId === sessionId) handleFirefoxStopCapture();
  };
  fxWs.onclose = () => {
    if (fxSessionId === sessionId) handleFirefoxStopCapture();
  };

  fxWs.onmessage = async (event) => {
    try {
      const serverMsg = JSON.parse(event.data) as ServerMessage;
      if (serverMsg.type === 'ERROR') {
        if (serverMsg.fatal) handleFirefoxStopCapture();
        return;
      }
      if (serverMsg.type === 'SUBTITLE_EVENT' && subtitleRenderer) {
        subtitleRenderer.showSubtitle(
          serverMsg.segmentId,
          serverMsg.text,
          (serverMsg.endMs - serverMsg.startMs) || 4000,
          serverMsg.generation
        );
      }
      if (serverMsg.type === 'TTS_CHUNK') {
        const sessionAtDecodeStart = fxSessionId;
        const generationAtDecodeStart = fxCurrentGeneration;
        const playbackEpochAtDecodeStart = fxPlaybackEpoch;
        if (
          serverMsg.generation === generationAtDecodeStart &&
          fxAudioCtx &&
          fxAudioMixer &&
          !video.paused &&
          serverMsg.endMs >= Math.round(video.currentTime * 1000) - 6000 &&
          fxAudioMixer.getTTSBacklogMs() < 8000
        ) {
          const binary = atob(serverMsg.audioBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const buffer = await fxAudioCtx.decodeAudioData(bytes.buffer);
          if (
            sessionAtDecodeStart &&
            sessionAtDecodeStart === fxSessionId &&
            generationAtDecodeStart === fxCurrentGeneration &&
            playbackEpochAtDecodeStart === fxPlaybackEpoch &&
            fxAudioCtx &&
            fxAudioMixer &&
            !video.paused
          ) {
            fxAudioMixer.playTTSBuffer(buffer);
          }
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
          sequence: fxSequence++,
          pcmBase64,
          videoTimeMs: Math.round(video.currentTime * 1000),
          audioTimeMs: timestampMs
        };
        fxWs.send(JSON.stringify(chunkMsg));
      }
    },
    16000,
    4096,
    () => Math.round(video.currentTime * 1000)
  );
}

function handleFirefoxStopCapture(): void {
  const sessionId = fxSessionId;
  fxPlaybackEpoch++;
  fxSessionId = null;
  if (fxWs && fxWs.readyState === WebSocket.OPEN && sessionId) {
    fxWs.send(JSON.stringify({
      type: 'SESSION_STOP',
      sessionId,
      timestamp: Date.now()
    } satisfies ClientMessage));
  }
  if (fxPcmProcessor) {
    fxPcmProcessor.stop();
    fxPcmProcessor = null;
  }
  if (fxAudioMixer) {
    fxAudioMixer.stopTTS();
    fxAudioMixer.disconnect();
    fxAudioMixer = null;
  }
  if (fxAudioCtx) {
    fxAudioCtx.close();
    fxAudioCtx = null;
  }
  if (fxWs) {
    fxWs.close();
    fxWs = null;
  }
  if (fxRestoreState && document.contains(fxRestoreState.video)) {
    fxRestoreState.video.muted = fxRestoreState.muted;
    fxRestoreState.video.volume = fxRestoreState.volume;
  }
  fxRestoreState = null;
}

// Automatically detect video on load, SPA navigation or DOM mutations
window.addEventListener('DOMContentLoaded', () => initVideoIntegration());
window.addEventListener('load', () => initVideoIntegration());
window.addEventListener('yt-navigate-finish', () => initVideoIntegration());

const observer = new MutationObserver(() => {
  const video = findVideoElement();
  if (!activeVideo || !document.contains(activeVideo) || (video && video !== activeVideo)) {
    initVideoIntegration();
  }
});
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}
