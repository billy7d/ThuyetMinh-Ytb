import { SubtitleRenderer } from './subtitle-renderer.js';
import { VideoSyncController } from '../sync/video-sync.js';
import { AudioMixer, AudioSourceMode } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import { AudioMixerConfig, ClientMessage, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME, OperationMode, ServerMessage } from '@vietdub/shared';

interface FirefoxSession {
  sessionId: string;
  mode: OperationMode;
  wsUrl: string;
  video: HTMLVideoElement;
  syncController: VideoSyncController | null;
  audioCtx: AudioContext | null;
  captureStream: MediaStream | null;
  audioMixer: AudioMixer | null;
  pcmProcessor: PCMProcessor | null;
  ws: WebSocket | null;
  generation: number;
  sequence: number;
  cancelled: boolean;
  ready: boolean;
  failureNotified: boolean;
  cleanupPromise: Promise<void> | null;
}

// Guard bảo đảm inject thủ công không tạo thêm listener hoặc observer.
if ((window as any).__VIETDUB_CONTENT_INJECTED__) {
  console.log('[CONTENT] Content script đã được nạp trước đó.');
} else {
  (window as any).__VIETDUB_CONTENT_INJECTED__ = true;

  let activeVideo: HTMLVideoElement | null = null;
  let activeVideoUrl = '';
  let subtitleRenderer: SubtitleRenderer | null = null;
  let syncController: VideoSyncController | null = null;
  let firefoxSession: FirefoxSession | null = null;
  let firefoxStartFlight: Promise<void> | null = null;

  function notifyBackground(message: unknown): void {
    try {
      const result = chrome.runtime.sendMessage(message as any);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        void (result as Promise<unknown>).catch((error) => {
          console.debug('[CONTENT] background notification skipped', JSON.stringify({ code: 'BACKGROUND_NOT_REACHABLE', message: String(error) }));
        });
      }
    } catch (error) {
      console.debug('[CONTENT] background notification failed', JSON.stringify({ code: 'BACKGROUND_NOTIFY_FAILED', message: String(error) }));
    }
  }

  function createRuntimeError(code: string, message: string, retryable = false, fatal = true): Error & {
    code: string;
    retryable: boolean;
    fatal: boolean;
  } {
    const error = new Error(message) as Error & { code: string; retryable: boolean; fatal: boolean };
    error.code = code;
    error.retryable = retryable;
    error.fatal = fatal;
    return error;
  }

  function assertCurrent(session: FirefoxSession): void {
    if (firefoxSession !== session || session.cancelled) {
      throw createRuntimeError('SESSION_CANCELLED', 'Phiên khởi tạo đã bị hủy.', false, false);
    }
  }

  function findVideoElement(): HTMLVideoElement | null {
    const youtubeVideo = document.querySelector<HTMLVideoElement>(
      'video.video-stream.html5-main-video, video.video-stream, video.html5-main-video, #movie_player video, .html5-video-player video'
    );
    if (youtubeVideo) return youtubeVideo;

    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    if (videos.length === 0) return null;

    const playing = videos.find((video) => !video.paused && video.currentTime > 0);
    if (playing) return playing;

    const withSource = videos.find((video) => !!video.src || !!video.srcObject || video.readyState > 0);
    if (withSource) return withSource;

    return videos.sort((a, b) => {
      const aArea = (a.clientWidth || a.videoWidth || 1) * (a.clientHeight || a.videoHeight || 1);
      const bArea = (b.clientWidth || b.videoWidth || 1) * (b.clientHeight || b.videoHeight || 1);
      return bArea - aArea;
    })[0];
  }

  function initVideoIntegration(force = false): boolean {
    const video = findVideoElement();
    if (!video) return false;

    const videoChanged = activeVideo !== video || activeVideoUrl !== location.href || force;
    if (!videoChanged && subtitleRenderer && syncController) return true;

    const previousSession = firefoxSession;
    if (previousSession && videoChanged) {
      void stopFirefoxSession(previousSession.sessionId, 'youtube-navigation');
    }

    if (syncController) {
      syncController.destroy();
      syncController = null;
    }

    activeVideo = video;
    activeVideoUrl = location.href;
    subtitleRenderer ||= new SubtitleRenderer();
    subtitleRenderer.attachToVideo(video);

    syncController = new VideoSyncController(video, {
      onStateChange: (state) => {
        notifyBackground({ type: 'VIDEO_STATE_UPDATE', state });
      },
      onSeek: (fromMs, toMs) => {
        // Chrome chuyển sự kiện tua qua background tới offscreen; Firefox gửi thêm trực tiếp cho WebSocket.
        notifyBackground({ type: 'SEEK_EVENT', fromMs, toMs });
        const session = firefoxSession;
        if (!session || session.video !== video || session.cancelled) return;
        session.generation += 1;
        if (session.ws?.readyState === WebSocket.OPEN) {
          const message: ClientMessage = {
            type: 'SEEK_EVENT',
            sessionId: session.sessionId,
            timestamp: Date.now(),
            fromMs,
            toMs,
            generation: session.generation
          };
          try {
            session.ws.send(JSON.stringify(message));
          } catch (error) {
            void failFirefoxSession(session, createRuntimeError('SEEK_SEND_FAILED', String(error), true, true));
          }
        }
      },
      onPause: () => {
        syncController?.stopActiveTTS();
      },
      onResume: () => {}
    });

    console.log('[CONTENT] Đã gắn controller cho video hiện tại.');
    return true;
  }

  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    switch (msg.type) {
      case 'CONTENT_PING':
      case 'CHECK_VIDEO': {
        const video = findVideoElement();
        if (video) initVideoIntegration();
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

      case 'SUBTITLE_EVENT':
        if (subtitleRenderer && msg.text) {
          subtitleRenderer.showSubtitle(msg.segmentId, msg.text, (msg.endMs - msg.startMs) || 4000);
        }
        sendResponse({ success: true });
        return false;

      case 'FIREFOX_START_CAPTURE':
        startFirefoxSession(msg.sessionId, msg.mode, msg.mixerConfig, msg.wsUrl)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({
            success: false,
            code: error?.code || 'FIREFOX_START_FAILED',
            retryable: error?.retryable === true,
            error: error?.message || String(error)
          }));
        return true;

      case 'FIREFOX_STOP_CAPTURE':
        stopFirefoxSession(msg.sessionId, msg.reason || 'user')
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, code: 'FIREFOX_STOP_FAILED', error: String(error) }));
        return true;

      case 'FIREFOX_UPDATE_MIXER':
        updateFirefoxMixer(msg.config || {}, msg.sessionId);
        sendResponse({ success: true });
        return false;

      case 'FIREFOX_CHANGE_MODE':
        changeFirefoxMode(msg.mode, msg.sessionId);
        sendResponse({ success: true });
        return false;

      default:
        return false;
    }
  });

  async function startFirefoxSession(
    sessionId: string,
    mode: OperationMode,
    mixerConfig?: Partial<AudioMixerConfig>,
    wsUrl = 'ws://localhost:8080'
  ): Promise<void> {
    if (!sessionId) throw createRuntimeError('INVALID_START_REQUEST', 'Thiếu sessionId.');
    if (firefoxSession?.sessionId === sessionId && firefoxStartFlight) return firefoxStartFlight;
    if (firefoxSession) await stopFirefoxSession(firefoxSession.sessionId, 'replaced-by-new-start');

    const video = findVideoElement();
    if (!video) throw createRuntimeError('VIDEO_NOT_FOUND', 'Chưa tìm thấy phần tử video trên trang hiện tại.', false, true);
    initVideoIntegration();

    const session: FirefoxSession = {
      sessionId,
      mode,
      wsUrl,
      video,
      syncController,
      audioCtx: null,
      captureStream: null,
      audioMixer: null,
      pcmProcessor: null,
      ws: null,
      generation: 1,
      sequence: 0,
      cancelled: false,
      ready: false,
      failureNotified: false,
      cleanupPromise: null
    };
    firefoxSession = session;

    const flight = runFirefoxStart(session, mixerConfig);
    firefoxStartFlight = flight;
    flight.then(
      () => {
        if (firefoxStartFlight === flight) firefoxStartFlight = null;
      },
      () => {
        if (firefoxStartFlight === flight) firefoxStartFlight = null;
      }
    );
    return flight;
  }

  async function runFirefoxStart(session: FirefoxSession, mixerConfig?: Partial<AudioMixerConfig>): Promise<void> {
    try {
      session.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      if (session.audioCtx.state === 'suspended') await session.audioCtx.resume();
      assertCurrent(session);

      const source = createFirefoxAudioSource(session);
      session.audioMixer = new AudioMixer(session.audioCtx, source.node, {
        sourceMode: source.mode,
        videoElement: source.mode === 'capture-stream' ? session.video : undefined,
        initialConfig: {
          originalVolume: Number.isFinite(mixerConfig?.originalVolume) ? mixerConfig!.originalVolume : DEFAULT_ORIGINAL_VOLUME,
          originalMuted: mixerConfig?.originalMuted === true,
          ttsVolume: Number.isFinite(mixerConfig?.ttsVolume) ? mixerConfig!.ttsVolume : DEFAULT_TTS_VOLUME
        }
      });

      await connectFirefoxWebSocket(session);
      assertCurrent(session);

      // Chỉ bắt đầu PCM sau khi backend đã xác nhận SESSION_READY.
      session.pcmProcessor = new PCMProcessor(
        session.audioCtx,
        session.audioMixer.getSTTTapNode(),
        (pcmBase64, timestampMs) => {
          if (firefoxSession !== session || session.cancelled || session.ws?.readyState !== WebSocket.OPEN) return;
          const message: ClientMessage = {
            type: 'AUDIO_CHUNK',
            sessionId: session.sessionId,
            timestamp: Date.now(),
            sequence: session.sequence++,
            pcmBase64,
            timestampMs
          };
          try {
            session.ws?.send(JSON.stringify(message));
          } catch (error) {
            void failFirefoxSession(session, createRuntimeError('AUDIO_SEND_FAILED', String(error), true, true));
          }
        }
      );
      assertCurrent(session);
      session.ready = true;
      notifyBackground({ type: 'SESSION_RUNTIME', sessionId: session.sessionId, state: 'ACTIVE' });
    } catch (error) {
      await cleanupFirefoxSession(session, 'start-failed');
      throw error;
    }
  }

  function createFirefoxAudioSource(session: FirefoxSession): {
    node: MediaElementAudioSourceNode | MediaStreamAudioSourceNode;
    mode: AudioSourceMode;
  } {
    if (!session.audioCtx) throw createRuntimeError('AUDIO_CONTEXT_MISSING', 'AudioContext chưa được khởi tạo.');

    // MediaElementSource điều khiển đúng đường loa gốc và tránh phát âm thanh hai lần.
    try {
      return { node: session.audioCtx.createMediaElementSource(session.video), mode: 'media-element' };
    } catch (mediaElementError) {
      const mediaVideo = session.video as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captureMethod = mediaVideo.captureStream || mediaVideo.mozCaptureStream;
      if (!captureMethod) {
        throw createRuntimeError('AUDIO_CAPTURE_UNSUPPORTED', `Firefox không hỗ trợ capture âm thanh video: ${String(mediaElementError)}`, false, true);
      }
      try {
        session.captureStream = captureMethod.call(session.video);
        return {
          node: session.audioCtx.createMediaStreamSource(session.captureStream),
          mode: 'capture-stream'
        };
      } catch (captureError) {
        throw createRuntimeError('AUDIO_CAPTURE_FAILED', `Không thể thu luồng âm thanh video: ${String(captureError)}`, false, true);
      }
    }
  }

  async function connectFirefoxWebSocket(session: FirefoxSession): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(createRuntimeError('WS_CONNECTION_TIMEOUT', 'Hết thời gian chờ phản hồi từ máy chủ AI.', true, true));
      }, 7000);

      try {
        session.ws = new WebSocket(session.wsUrl);
      } catch (error) {
        clearTimeout(timeout);
        reject(createRuntimeError('WS_CONNECTION_FAILED', `Không thể kết nối máy chủ WebSocket: ${String(error)}`, true, true));
        return;
      }

      const socket = session.ws;
      socket.onopen = () => {
        if (firefoxSession !== session || session.cancelled) return;
        const message: ClientMessage = {
          type: 'SESSION_START',
          sessionId: session.sessionId,
          timestamp: Date.now(),
          mode: session.mode,
          audioSampleRate: 16000,
          videoUrl: location.href,
          videoTitle: document.title
        };
        try {
          socket.send(JSON.stringify(message));
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(createRuntimeError('WS_SEND_FAILED', String(error), true, true));
          }
        }
      };

      socket.onerror = (event) => {
        const error = createRuntimeError('WS_CONNECTION_FAILED', 'Không thể kết nối máy chủ xử lý thuyết minh.', true, true);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else if (firefoxSession === session && !session.cancelled) {
          void failFirefoxSession(session, error);
        }
        console.error('[CONTENT] WebSocket error', JSON.stringify({ code: error.code, message: String(event) }));
      };

      socket.onclose = (event) => {
        const error = createRuntimeError('WS_DISCONNECTED', 'Máy chủ WebSocket đã ngắt kết nối.', true, true);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else if (firefoxSession === session && !session.cancelled) {
          void failFirefoxSession(session, error);
        }
        console.log('[CONTENT] WebSocket closed', JSON.stringify({ code: event.code, reason: event.reason }));
      };

      socket.onmessage = (event) => {
        if (firefoxSession !== session || session.cancelled) return;
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.sessionId !== session.sessionId) return;
          if (message.type === 'SESSION_READY' && !settled) {
            settled = true;
            clearTimeout(timeout);
            session.ready = true;
            resolve();
          }
          void handleFirefoxServerMessage(session, message);
        } catch (error) {
          console.error('[CONTENT] WebSocket message parse failed', JSON.stringify({ code: 'WS_MESSAGE_INVALID', message: String(error) }));
        }
      };
    });
  }

  async function handleFirefoxServerMessage(session: FirefoxSession, message: ServerMessage): Promise<void> {
    if (firefoxSession !== session || session.cancelled) return;
    if (message.type === 'LATENCY_METRIC') notifyBackground(message);
    if (message.type === 'ERROR') {
      notifyBackground(message);
      if (message.fatal || session.ready) {
        await failFirefoxSession(session, createRuntimeError(message.code, message.message, false, message.fatal));
      }
      return;
    }
    if (message.type === 'SUBTITLE_EVENT' && subtitleRenderer && message.action === 'show') {
      subtitleRenderer.showSubtitle(message.segmentId, message.text, (message.endMs - message.startMs) || 4000);
    }
    if (message.type === 'TTS_CHUNK' && message.generation === session.generation && session.audioCtx && session.audioMixer) {
      try {
        const binary = atob(message.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const audioBuffer = await session.audioCtx.decodeAudioData(bytes.buffer);
        if (firefoxSession === session && !session.cancelled && message.generation === session.generation && session.audioMixer) {
          const source = session.audioMixer.playTTSBuffer(audioBuffer);
          session.syncController?.setActiveTTSSource(source);
        }
      } catch (error) {
        console.error('[CONTENT] TTS playback failed', JSON.stringify({ code: 'TTS_PLAY_FAILED', message: String(error) }));
      }
    }
  }

  function updateFirefoxMixer(config: Partial<AudioMixerConfig>, sessionId?: string): void {
    const session = firefoxSession;
    if (!session || (sessionId && session.sessionId !== sessionId) || !session.audioMixer) return;
    if (config.originalVolume !== undefined) session.audioMixer.setOriginalVolume(config.originalVolume);
    if (config.originalMuted !== undefined) session.audioMixer.setOriginalMuted(config.originalMuted);
    if (config.ttsVolume !== undefined) session.audioMixer.setTTSVolume(config.ttsVolume);
  }

  function changeFirefoxMode(mode: OperationMode, sessionId?: string): void {
    const session = firefoxSession;
    if (!session || (sessionId && session.sessionId !== sessionId)) return;
    session.mode = mode;
    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'MODE_CHANGE',
        sessionId: session.sessionId,
        timestamp: Date.now(),
        mode
      } satisfies ClientMessage));
    }
  }

  async function failFirefoxSession(
    session: FirefoxSession,
    error: Error & { code?: string; retryable?: boolean; fatal?: boolean }
  ): Promise<void> {
    if (session.failureNotified || session.cancelled) return;
    session.failureNotified = true;
    notifyBackground({
      type: 'SESSION_RUNTIME',
      sessionId: session.sessionId,
      state: 'ERROR',
      error: {
        code: error.code || 'RUNTIME_ERROR',
        message: error.message,
        retryable: error.retryable === true,
        fatal: error.fatal !== false
      }
    });
    await stopFirefoxSession(session.sessionId, 'runtime-failure');
  }

  async function stopFirefoxSession(sessionId?: string, reason = 'user'): Promise<void> {
    const session = firefoxSession;
    if (!session || (sessionId && session.sessionId !== sessionId)) return;
    firefoxSession = null;
    session.cancelled = true;
    await cleanupFirefoxSession(session, reason);
  }

  async function cleanupFirefoxSession(session: FirefoxSession, reason: string): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupPromise = (async () => {
      if (session.pcmProcessor) {
        session.pcmProcessor.stop();
        session.pcmProcessor = null;
      }
      if (session.audioMixer) {
        session.audioMixer.disconnect();
        session.audioMixer = null;
      }
      if (session.captureStream) {
        for (const track of session.captureStream.getTracks()) track.stop();
        session.captureStream = null;
      }
      if (session.audioCtx) {
        try {
          await session.audioCtx.close();
        } catch (error) {
          console.error('[CONTENT] AudioContext close failed', JSON.stringify({ code: 'AUDIO_CONTEXT_CLOSE_FAILED', message: String(error), reason }));
        }
        session.audioCtx = null;
      }
      if (session.ws) {
        const socket = session.ws;
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({
              type: 'SESSION_STOP',
              sessionId: session.sessionId,
              timestamp: Date.now(),
              reason
            } satisfies ClientMessage));
          } catch (error) {
            console.warn('[CONTENT] SESSION_STOP send failed', JSON.stringify({ code: 'SESSION_STOP_SEND_FAILED', message: String(error) }));
          }
        }
        try {
          socket.close();
        } catch (error) {
          console.warn('[CONTENT] WebSocket close failed', JSON.stringify({ code: 'WS_CLOSE_FAILED', message: String(error) }));
        }
        session.ws = null;
      }
      session.ready = false;
      session.syncController?.stopActiveTTS();
      if (session.video === activeVideo) subtitleRenderer?.hideSubtitle();
    })();
    return session.cleanupPromise;
  }

  window.addEventListener('DOMContentLoaded', () => initVideoIntegration());
  window.addEventListener('load', () => initVideoIntegration());
  window.addEventListener('yt-navigate-finish', () => initVideoIntegration(true));
  window.addEventListener('beforeunload', () => {
    if (firefoxSession) void stopFirefoxSession(firefoxSession.sessionId, 'document-unload');
  });

  // Một observer duy nhất để nhận biết YouTube thay thế node video trong SPA.
  const observer = new MutationObserver(() => {
    if (!activeVideo || !document.contains(activeVideo)) initVideoIntegration();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
}
