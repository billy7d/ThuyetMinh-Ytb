import { SubtitleRenderer } from './subtitle-renderer.js';
import { VideoSyncController } from '../sync/video-sync.js';
import { AudioMixer } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import { ClientMessage, ServerMessage, OperationMode, AudioMixerConfig } from '@vietdub/shared';

// Idempotent guard: Ensure content script is only initialized once per execution realm
if ((window as any).__VIETDUB_CONTENT_INJECTED__) {
  console.log('[CONTENT] VietDub content script already injected on this page.');
} else {
  (window as any).__VIETDUB_CONTENT_INJECTED__ = true;

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
      'video.video-stream.html5-main-video, video.video-stream, video.html5-main-video, #movie_player video, .html5-video-player video'
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

    if (activeVideo === video && subtitleRenderer && syncController) {
      return true;
    }

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
          syncController?.stopActiveTTS();
        },
        onResume: () => {}
      });
    }

    console.log('[CONTENT] Video integration initialized for element:', video);
    return true;
  }

  // Listen for messages from background/popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'CONTENT_PING':
      case 'CHECK_VIDEO': {
        const video = findVideoElement();
        if (video && !activeVideo) {
          initVideoIntegration();
        }
        console.log(`[CONTENT] Received ${msg.type}, hasVideo: ${!!video}`);
        sendResponse({
          success: true,
          ready: true,
          hasVideo: !!video,
          videoTitle: document.title,
          currentTime: video?.currentTime || 0,
          paused: video?.paused ?? true
        });
        return false;
      }

      case 'SUBTITLE_EVENT': {
        if (subtitleRenderer && msg.text) {
          subtitleRenderer.showSubtitle(msg.segmentId, msg.text, (msg.endMs - msg.startMs) || 4000);
        }
        sendResponse({ success: true });
        return false;
      }

      // Firefox Direct Audio Capture Handling
      case 'FIREFOX_START_CAPTURE': {
        console.log(`[CONTENT] Received FIREFOX_START_CAPTURE for session ${msg.sessionId}`);
        handleFirefoxStartCapture(msg.sessionId, msg.mode, msg.mixerConfig, msg.wsUrl)
          .then(() => {
            console.log(`[CONTENT] Capture & session successfully started for ${msg.sessionId}`);
            sendResponse({ success: true });
          })
          .catch((err: any) => {
            console.error('[CONTENT] Start capture failed:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true;
      }

      case 'FIREFOX_STOP_CAPTURE': {
        console.log(`[CONTENT] Received FIREFOX_STOP_CAPTURE`);
        handleFirefoxStopCapture();
        sendResponse({ success: true });
        return false;
      }

      case 'FIREFOX_UPDATE_MIXER': {
        if (fxAudioMixer) {
          if (msg.config.originalVolume !== undefined) fxAudioMixer.setOriginalVolume(msg.config.originalVolume);
          if (msg.config.originalMuted !== undefined) fxAudioMixer.setOriginalMuted(msg.config.originalMuted);
          if (msg.config.ttsVolume !== undefined) fxAudioMixer.setTTSVolume(msg.config.ttsVolume);
        }
        sendResponse({ success: true });
        return false;
      }

      case 'FIREFOX_CHANGE_MODE': {
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

      default:
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
    if (!video) {
      throw new Error('Chưa tìm thấy phần tử video trên trang YouTube/HTML5. Vui lòng bấm Play video trước.');
    }

    initVideoIntegration();
    fxSessionId = sessionId;

    // Initialize Web Audio Context and ensure it is resumed
    fxAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (fxAudioCtx.state === 'suspended') {
      try {
        await fxAudioCtx.resume();
      } catch (e) {
        console.warn('[CONTENT] AudioContext resume warning:', e);
      }
    }

    let sourceNode: MediaElementAudioSourceNode | MediaStreamAudioSourceNode;
    try {
      if (video.captureStream || (video as any).mozCaptureStream) {
        const stream = (video.captureStream || (video as any).mozCaptureStream).call(video);
        sourceNode = fxAudioCtx.createMediaStreamSource(stream);
      } else {
        sourceNode = fxAudioCtx.createMediaElementSource(video);
      }
    } catch (captureErr: any) {
      console.error('[CONTENT] Audio capture error:', captureErr);
      throw new Error(`Không thể thu luồng âm thanh từ video: ${captureErr.message}`);
    }

    fxAudioMixer = new AudioMixer(fxAudioCtx, sourceNode);
    if (mixerConfig) {
      if (mixerConfig.originalVolume !== undefined) fxAudioMixer.setOriginalVolume(mixerConfig.originalVolume);
      if (mixerConfig.originalMuted !== undefined) fxAudioMixer.setOriginalMuted(mixerConfig.originalMuted);
      if (mixerConfig.ttsVolume !== undefined) fxAudioMixer.setTTSVolume(mixerConfig.ttsVolume);
    }

    // Connect WebSocket and wait for backend confirmation (SESSION_READY)
    await new Promise<void>((resolve, reject) => {
      let isResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          handleFirefoxStopCapture();
          reject(new Error('Hết thời gian chờ phản hồi từ máy chủ AI (Timeout). Vui lòng đảm bảo backend đang chạy.'));
        }
      }, 7000);

      try {
        fxWs = new WebSocket(wsUrl);
      } catch (wsErr: any) {
        clearTimeout(connectionTimeout);
        reject(new Error(`Không thể kết nối đến máy chủ WebSocket (${wsUrl}): ${wsErr.message}`));
        return;
      }

      fxWs.onopen = () => {
        console.log(`[CONTENT] WebSocket connected to ${wsUrl}, sending SESSION_START...`);
        const startMsg: ClientMessage = {
          type: 'SESSION_START',
          sessionId,
          timestamp: Date.now(),
          mode,
          audioSampleRate: 16000
        };
        fxWs?.send(JSON.stringify(startMsg));
      };

      fxWs.onerror = (err) => {
        console.error('[CONTENT] WebSocket connection error:', err);
        if (!isResolved) {
          isResolved = true;
          clearTimeout(connectionTimeout);
          handleFirefoxStopCapture();
          reject(new Error('Không thể kết nối với máy chủ xử lý thuyết minh (ws://localhost:8080). Vui lòng kiểm tra backend.'));
        }
      };

      fxWs.onclose = (ev) => {
        console.log(`[CONTENT] WebSocket closed with code ${ev.code}, reason: ${ev.reason}`);
        if (!isResolved) {
          isResolved = true;
          clearTimeout(connectionTimeout);
          handleFirefoxStopCapture();
          reject(new Error('Máy chủ WebSocket đã đóng kết nối trước khi khởi tạo phiên thành công.'));
        }
      };

      fxWs.onmessage = async (event) => {
        try {
          const serverMsg = JSON.parse(event.data) as ServerMessage;

          // Resolve promise when backend is ready
          if (serverMsg.type === 'SESSION_READY') {
            console.log(`[CONTENT] SESSION_READY confirmed by backend!`);
            if (!isResolved) {
              isResolved = true;
              clearTimeout(connectionTimeout);
              resolve();
            }
          }

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
        } catch (msgErr) {
          console.error('[CONTENT] Error processing server message:', msgErr);
        }
      };
    });

    // Start PCM streaming ONLY AFTER backend confirmed SESSION_READY
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

    console.log('[CONTENT] Streaming PCM audio processor started.');
  }

  function handleFirefoxStopCapture(): void {
    console.log('[CONTENT] Stopping audio capture and cleaning up resources.');
    if (fxPcmProcessor) {
      fxPcmProcessor.stop();
      fxPcmProcessor = null;
    }
    if (fxAudioMixer) {
      fxAudioMixer.disconnect();
      fxAudioMixer = null;
    }
    if (fxAudioCtx) {
      fxAudioCtx.close().catch(() => {});
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
    if (subtitleRenderer) {
      subtitleRenderer.hideSubtitle();
    }
    if (syncController) {
      syncController.stopActiveTTS();
    }
  }

  // Lifecycle observers
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
}
