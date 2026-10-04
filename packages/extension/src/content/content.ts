import { SubtitleRenderer, resolveSubtitleDisplayDurationMs } from './subtitle-renderer.js';
import { VideoSyncController } from '../sync/video-sync.js';
import { AudioMixer, AudioSourceMode } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import { AudioContextBlockedError, ensureAudioContextRunning } from '../audio/audio-context-guard.js';
import {
  AudioMixerConfig,
  CaptionWord,
  ClientMessage,
  DEFAULT_ORIGINAL_VOLUME,
  DEFAULT_TTS_VOLUME,
  OperationMode,
  ScriptSegment,
  ServerMessage,
  diagnosticSessionRef,
  emitDiagnostic
} from '@vietdub/shared';
import { SESSION_READY_TIMEOUT_MS, isRetryableServerError } from '../errors/runtime-errors.js';
import { RelaySocket, SocketLike, WS_RELAY_PORT_NAME } from '../relay/ws-relay.js';
import { isSameVideo } from '../navigation/video-identity.js';
import { TtsStreamReceiver } from '../audio/tts-stream-receiver.js';
import { SyncedSubtitleRelease, TtsSubtitleSync, ttsSlotMs, ttsTotalDisplayMs } from '../sync/tts-subtitle-sync.js';
import { CaptionScriptResult, requestCaptionScript, youtubeVideoId } from '../captions/caption-messages.js';
import { chunkCaptionWords } from '../captions/caption-script.js';
import { ScriptDubPlayer } from '../captions/script-player.js';

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
  ws: SocketLike | null;
  generation: number;
  sequence: number;
  cancelled: boolean;
  ready: boolean;
  playbackEpoch: number;
  failureNotified: boolean;
  cleanupPromise: Promise<void> | null;
  /** Số chunk PCM im lặng tuyệt đối liên tiếp trong lúc video đang phát. */
  silentChunks: number;
  lastRecaptureAt: number;
  detachCaptureWatch: (() => void) | null;
  /** Giữ phụ đề tới đúng lúc giọng đọc cùng câu bắt đầu phát. */
  subtitleSync: TtsSubtitleSync | null;
  /** Nhận giọng đọc dạng luồng (TTS_CHUNK audio/pcm); tạo khi có đoạn đầu tiên. */
  ttsReceiver: TtsStreamReceiver | null;
  /** Chế độ đọc trước theo phụ đề YouTube (có phụ đề tiếng Anh do người làm); null = nhận dạng giọng nói như cũ. */
  script: ScriptDubPlayer | null;
  /** Phụ đề tự động đang chờ backend thêm dấu câu: requestId -> nhận các câu. */
  punctuationWaiters: Map<string, (segments: ScriptSegment[]) => void>;
}

/** Câu đầu tiên để bắt đầu đọc trước, kèm các phần phụ đề tự động còn lại (thêm dấu câu dần sau khi đã bắt đầu). */
interface PreparedScript {
  segments: ScriptSegment[];
  remainingWords: CaptionWord[][];
  source: 'manual' | 'asr' | 'none';
  reason: string;
}

/** Chờ phụ đề tối đa chừng này lúc bắt đầu; lâu hơn (đang quảng cáo…) thì chạy nhận dạng giọng nói trước, có phụ đề thì chuyển. */
const CAPTIONS_FAST_WAIT_MS = 4_000;

// Video đang phát mà thu được ~3 s toàn số 0 nghĩa là track captureStream đã chết (trang đổi nguồn phát).
const SILENT_CHUNKS_BEFORE_RECAPTURE = 12;
const MIN_RECAPTURE_INTERVAL_MS = 3_000;

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

    // So theo danh tính video, không theo nguyên URL: YouTube tự sửa query khi vẫn phát cùng video.
    const elementChanged = activeVideo !== video;
    const identityChanged = Boolean(activeVideoUrl) && !isSameVideo(activeVideoUrl, location.href);
    if (!elementChanged && !identityChanged && subtitleRenderer && syncController) {
      activeVideoUrl = location.href;
      return true;
    }
    emitDiagnostic('content', 'video_integration_changed', {
      elementChanged,
      identityChanged,
      force,
      hadSession: Boolean(firefoxSession)
    });

    const previousSession = firefoxSession;
    if (previousSession && (elementChanged || identityChanged)) {
      // Âm thanh đang thu gắn với thẻ video cũ: dừng và báo rõ cho popup thay vì dừng lặng lẽ (popup vẫn hiện "đang thuyết minh").
      void failFirefoxSession(previousSession, createRuntimeError(
        'VIDEO_NAVIGATION',
        identityChanged ? 'Đã chuyển sang video khác.' : 'Trình phát đã thay thẻ video.',
        true,
        true
      ));
    }

    if (syncController) {
      syncController.destroy();
      syncController = null;
    }

    activeVideo = video;
    activeVideoUrl = location.href;
    subtitleRenderer ||= new SubtitleRenderer();
    subtitleRenderer.attachToVideo(video);
    emitDiagnostic('content', 'video_ready', { hasVideo: true, force });

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
        session.playbackEpoch += 1;
        session.subtitleSync?.clear();
        session.syncController?.stopActiveTTS();
        // Dừng cả các câu TTS đã xếp lịch phát sau câu hiện tại.
        session.audioMixer?.stopTTS();
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
        // Sau SEEK_EVENT để các câu gửi lại mang lượt (generation) mới.
        session.script?.handleSeek();
      },
      onPause: () => {
        const session = firefoxSession;
        if (session && !session.cancelled) {
          session.playbackEpoch += 1;
          session.audioMixer?.stopTTS();
          session.subtitleSync?.clear();
          session.script?.handlePause();
        }
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
          paused: video?.paused ?? true,
          videoState: video ? {
            currentTime: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            paused: video.paused,
            playbackRate: video.playbackRate,
            seeking: video.seeking
          } : undefined
        });
        return false;
      }

      case 'SUBTITLE_EVENT':
        emitDiagnostic('content', 'subtitle_event_received', {
          sessionRef: diagnosticSessionRef(msg.sessionId),
          hasText: Boolean(msg.text),
          textLength: typeof msg.text === 'string' ? msg.text.length : 0
        });
        if (subtitleRenderer && msg.text) {
          const timing = { startMs: msg.startMs, endMs: msg.endMs };
          // Chrome: offscreen đã giữ phụ đề tới đúng lúc giọng đọc bắt đầu, nên hiện ngay theo thời lượng giọng đọc.
          const displayed = msg.syncWithTts
            ? subtitleRenderer.showSyncedSubtitle(msg.segmentId, msg.text, msg.ttsDurationMs, msg.generation ?? 0, timing)
            : subtitleRenderer.showSubtitle(
              msg.segmentId,
              msg.text,
              resolveSubtitleDisplayDurationMs(msg.startMs, msg.endMs),
              msg.generation ?? 0,
              timing
            );
          emitDiagnostic('content', 'subtitle_event_rendered', {
            sessionRef: diagnosticSessionRef(msg.sessionId),
            displayed
          });
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
    wsUrl = 'ws://127.0.0.1:8080'
  ): Promise<void> {
    if (!sessionId) throw createRuntimeError('INVALID_START_REQUEST', 'Thiếu sessionId.');
    emitDiagnostic('firefox_capture', 'start_requested', { sessionRef: diagnosticSessionRef(sessionId), mode });
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
      playbackEpoch: 1,
      failureNotified: false,
      cleanupPromise: null,
      silentChunks: 0,
      lastRecaptureAt: 0,
      subtitleSync: null,
      ttsReceiver: null,
      script: null,
      punctuationWaiters: new Map(),
      detachCaptureWatch: null
    };
    session.subtitleSync = new TtsSubtitleSync(item => showReleasedSubtitle(session, item));
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
    // Hỏi phụ đề song song với khởi tạo âm thanh và kết nối backend.
    const videoId = youtubeVideoId(location.href);
    const captions: Promise<CaptionScriptResult> = videoId
      ? requestCaptionScript(videoId)
      : Promise.resolve({ segments: [], asrWords: [], reason: 'not-youtube' });
    try {
      session.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      try {
        await ensureAudioContextRunning(session.audioCtx);
      } catch (error) {
        if (!(error instanceof AudioContextBlockedError)) throw error;
        throw createRuntimeError(
          'AUDIO_CONTEXT_BLOCKED',
          'Firefox đang chặn âm thanh của trang cho tới khi bạn tương tác với trang.',
          false,
          true
        );
      }
      assertCurrent(session);
      emitDiagnostic('firefox_capture', 'audio_context_ready', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        state: session.audioCtx.state,
        sampleRate: session.audioCtx.sampleRate
      });

      const source = createFirefoxAudioSource(session);
      session.audioMixer = new AudioMixer(session.audioCtx, source.node, {
        sourceMode: source.mode,
        // Giữ lại trạng thái native của video cho cả nhánh fallback để cleanup có thể khôi phục.
        videoElement: session.video,
        initialConfig: {
          originalVolume: Number.isFinite(mixerConfig?.originalVolume) ? mixerConfig!.originalVolume : DEFAULT_ORIGINAL_VOLUME,
          originalMuted: mixerConfig?.originalMuted === true,
          ttsVolume: Number.isFinite(mixerConfig?.ttsVolume) ? mixerConfig!.ttsVolume : DEFAULT_TTS_VOLUME
        }
      });
      emitDiagnostic('firefox_capture', 'audio_graph_ready', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        sourceMode: source.mode
      });

      await connectFirefoxWebSocket(session);
      assertCurrent(session);

      const prepared = prepareScript(session, captions);
      const early = await Promise.race([
        prepared,
        new Promise<null>(resolve => setTimeout(() => resolve(null), CAPTIONS_FAST_WAIT_MS))
      ]);
      assertCurrent(session);
      if (early && early.segments.length > 0) {
        startScriptDubbing(session, early);
        session.ready = true;
        notifyBackground({ type: 'SESSION_RUNTIME', sessionId: session.sessionId, state: 'ACTIVE' });
        return;
      }
      if (early) {
        emitDiagnostic('firefox_script', 'captions_unavailable', { sessionRef: diagnosticSessionRef(session.sessionId), reason: early.reason });
      }

      // Chỉ bắt đầu PCM sau khi backend đã xác nhận SESSION_READY.
      session.pcmProcessor = new PCMProcessor(
        session.audioCtx,
        session.audioMixer.getSTTTapNode(),
        (pcmBase64, timestampMs, audioTimeMs, rms) => {
          if (firefoxSession !== session || session.cancelled || session.ws?.readyState !== WebSocket.OPEN) return;
          watchForDeadCapture(session, rms);
          const message: ClientMessage = {
            type: 'AUDIO_CHUNK',
            sessionId: session.sessionId,
            timestamp: Date.now(),
            sequence: session.sequence++,
            pcmBase64,
            videoTimeMs: timestampMs,
            audioTimeMs
          };
          try {
            session.ws?.send(JSON.stringify(message));
          } catch (error) {
            void failFirefoxSession(session, createRuntimeError('AUDIO_SEND_FAILED', String(error), true, true));
          }
        },
        16000,
        4096,
        session.sessionId,
        () => Math.max(0, Math.round(session.video.currentTime * 1000))
      );
      assertCurrent(session);
      session.ready = true;
      notifyBackground({ type: 'SESSION_RUNTIME', sessionId: session.sessionId, state: 'ACTIVE' });
      if (!early) {
        void prepared.then(result => {
          if (result.segments.length > 0) switchToScriptDubbing(session, result);
          else emitDiagnostic('firefox_script', 'captions_unavailable', { sessionRef: diagnosticSessionRef(session.sessionId), reason: result.reason });
        });
      }
    } catch (error) {
      await cleanupFirefoxSession(session, 'start-failed');
      throw error;
    }
  }

  /**
   * Câu để đọc trước: phụ đề do người làm dùng ngay; phụ đề tự động gửi phần quanh vị trí đang xem cho backend thêm dấu câu
   * (CAPTION_WORDS -> SCRIPT_SENTENCES), các phần còn lại xử lý sau khi đã bắt đầu.
   */
  async function prepareScript(session: FirefoxSession, captions: Promise<CaptionScriptResult>): Promise<PreparedScript> {
    const result = await captions;
    if (result.segments.length > 0) return { segments: result.segments, remainingWords: [], source: 'manual', reason: '' };
    if (result.asrWords.length === 0) return { segments: [], remainingWords: [], source: 'none', reason: result.reason };
    const chunks = chunkCaptionWords(result.asrWords, Math.round(session.video.currentTime * 1000));
    const startedAt = Date.now();
    const first = await punctuateWords(session, chunks[0]);
    emitDiagnostic('firefox_script', 'asr_punctuated', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      words: chunks[0].length,
      sentences: first.length,
      durationMs: Date.now() - startedAt,
      chunks: chunks.length
    });
    return {
      segments: first,
      remainingWords: chunks.slice(1),
      source: 'asr',
      reason: first.length > 0 ? '' : 'asr-punctuation-failed'
    };
  }

  function punctuateWords(session: FirefoxSession, words: CaptionWord[], timeoutMs = 30_000): Promise<ScriptSegment[]> {
    return new Promise(resolve => {
      if (firefoxSession !== session || session.cancelled || session.ws?.readyState !== WebSocket.OPEN || words.length === 0) {
        resolve([]);
        return;
      }
      const requestId = `pw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        session.punctuationWaiters.delete(requestId);
        resolve([]);
      }, timeoutMs);
      session.punctuationWaiters.set(requestId, segments => {
        clearTimeout(timer);
        session.punctuationWaiters.delete(requestId);
        resolve(segments);
      });
      try {
        session.ws.send(JSON.stringify({
          type: 'CAPTION_WORDS',
          sessionId: session.sessionId,
          timestamp: Date.now(),
          requestId,
          words
        } satisfies ClientMessage));
      } catch {
        clearTimeout(timer);
        session.punctuationWaiters.delete(requestId);
        resolve([]);
      }
    });
  }

  /** Các phần phụ đề tự động còn lại: thêm dấu câu lần lượt rồi bổ sung câu cho bộ phát. */
  async function loadRemainingWords(session: FirefoxSession, chunks: CaptionWord[][]): Promise<void> {
    for (const chunk of chunks) {
      if (firefoxSession !== session || session.cancelled || !session.script) return;
      const segments = await punctuateWords(session, chunk);
      session.script?.addSegments(segments);
    }
  }

  /** Có phụ đề tiếng Anh: dịch và đọc trước, phát giọng đúng lúc câu gốc bắt đầu (không gửi âm thanh cho STT). */
  function startScriptDubbing(session: FirefoxSession, captions: PreparedScript): void {
    if (!session.audioCtx || !session.audioMixer) throw createRuntimeError('AUDIO_CONTEXT_MISSING', 'AudioContext chưa được khởi tạo.');
    session.script = new ScriptDubPlayer({
      video: session.video,
      audioCtx: session.audioCtx,
      mixer: session.audioMixer,
      segments: captions.segments,
      getMode: () => session.mode,
      send: segments => {
        if (firefoxSession !== session || session.cancelled || session.ws?.readyState !== WebSocket.OPEN) return;
        const message: ClientMessage = {
          type: 'SCRIPT_SEGMENTS',
          sessionId: session.sessionId,
          timestamp: Date.now(),
          generation: session.generation,
          segments
        };
        try {
          session.ws.send(JSON.stringify(message));
        } catch (error) {
          void failFirefoxSession(session, createRuntimeError('SCRIPT_SEND_FAILED', String(error), true, true));
        }
      },
      showSubtitle: (segment, text, durationMs) => {
        if (firefoxSession !== session || session.cancelled || !subtitleRenderer) return;
        subtitleRenderer.showSyncedSubtitle(segment.segmentId, text, durationMs, session.generation, { startMs: segment.startMs, endMs: segment.endMs });
      },
      onSource: source => session.syncController?.setActiveTTSSource(source),
      diagScope: 'firefox_script'
    });
    emitDiagnostic('firefox_script', 'started', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      segments: session.script.segmentCount,
      source: captions.source
    });
    session.script.start();
    if (captions.remainingWords.length > 0) void loadRemainingWords(session, captions.remainingWords);
  }

  /** Phụ đề tới muộn (sau quảng cáo…): dừng gửi âm thanh cho nhận dạng giọng nói và chuyển sang đọc trước theo phụ đề. */
  function switchToScriptDubbing(session: FirefoxSession, captions: PreparedScript): void {
    if (firefoxSession !== session || session.cancelled || session.script || session.ws?.readyState !== WebSocket.OPEN) return;
    session.pcmProcessor?.stop();
    session.pcmProcessor = null;
    session.audioMixer?.stopTTS();
    session.subtitleSync?.clear();
    // Lượt mới (như tua tại chỗ): backend bỏ các câu nhận dạng giọng nói đang xử lý, giọng đọc cũ không phát chen vào.
    session.generation += 1;
    session.playbackEpoch += 1;
    const atMs = Math.max(0, Math.round(session.video.currentTime * 1000));
    try {
      session.ws.send(JSON.stringify({
        type: 'SEEK_EVENT',
        sessionId: session.sessionId,
        timestamp: Date.now(),
        fromMs: atMs,
        toMs: atMs,
        generation: session.generation
      } satisfies ClientMessage));
    } catch (error) {
      void failFirefoxSession(session, createRuntimeError('SEEK_SEND_FAILED', String(error), true, true));
      return;
    }
    emitDiagnostic('firefox_script', 'switched_from_stt', { sessionRef: diagnosticSessionRef(session.sessionId) });
    startScriptDubbing(session, captions);
  }

  function createFirefoxAudioSource(session: FirefoxSession): {
    node: MediaElementAudioSourceNode | MediaStreamAudioSourceNode;
    mode: AudioSourceMode;
  } {
    if (!session.audioCtx) throw createRuntimeError('AUDIO_CONTEXT_MISSING', 'AudioContext chưa được khởi tạo.');

    const mediaVideo = session.video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const captureMethod = mediaVideo.captureStream || mediaVideo.mozCaptureStream;

    // Ưu tiên captureStream để giữ đường phát native của video, tránh double audio và dễ khôi phục volume.
    if (captureMethod) {
      try {
        session.captureStream = captureMethod.call(session.video);
        if (session.captureStream.getAudioTracks().length > 0) {
          emitDiagnostic('firefox_capture', 'source_ready', {
            sessionRef: diagnosticSessionRef(session.sessionId),
            sourceMode: 'capture-stream',
            audioTracks: session.captureStream.getAudioTracks().length
          });
          watchCaptureStream(session, session.captureStream);
          return {
            node: session.audioCtx.createMediaStreamSource(session.captureStream),
            mode: 'capture-stream'
          };
        }
        for (const track of session.captureStream.getTracks()) track.stop();
        session.captureStream = null;
      } catch (captureError) {
        emitDiagnostic('firefox_capture', 'capture_stream_failed', {
          sessionRef: diagnosticSessionRef(session.sessionId),
          errorLength: String(captureError).length
        });
        session.captureStream = null;
      }
    }

    // Fallback cuối cùng cho Firefox cũ: MediaElementSource vẫn cần được đo RMS thực tế qua log PCM.
    try {
      emitDiagnostic('firefox_capture', 'source_ready', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        sourceMode: 'media-element'
      });
      return { node: session.audioCtx.createMediaElementSource(session.video), mode: 'media-element' };
    } catch (mediaElementError) {
      throw createRuntimeError(
        'AUDIO_CAPTURE_UNSUPPORTED',
        `Firefox không hỗ trợ capture âm thanh video: ${String(mediaElementError)}`,
        false,
        true
      );
    }
  }

  /** Theo dõi track của captureStream: YouTube đổi nguồn phát thì track cũ kết thúc hoặc track mới được thêm. */
  function watchCaptureStream(session: FirefoxSession, stream: MediaStream): void {
    session.detachCaptureWatch?.();
    const tracks = stream.getAudioTracks();
    const onAddTrack = (event: MediaStreamTrackEvent) => {
      if (event.track?.kind === 'audio') recaptureAudio(session, 'track-added');
    };
    const onEnded = () => recaptureAudio(session, 'track-ended');
    stream.addEventListener('addtrack', onAddTrack);
    for (const track of tracks) track.addEventListener('ended', onEnded);
    session.detachCaptureWatch = () => {
      stream.removeEventListener('addtrack', onAddTrack);
      for (const track of tracks) track.removeEventListener('ended', onEnded);
    };
  }

  function watchForDeadCapture(session: FirefoxSession, rms: number): void {
    const video = session.video;
    const playing = !video.paused && !video.ended && video.readyState >= 2 && !video.muted && video.volume > 0;
    session.silentChunks = playing && rms === 0 ? session.silentChunks + 1 : 0;
    if (session.silentChunks >= SILENT_CHUNKS_BEFORE_RECAPTURE) recaptureAudio(session, 'silence-watchdog');
  }

  /** Thu lại âm thanh video vào cùng đồ thị Web Audio, giữ nguyên phiên WebSocket và bộ trộn. */
  function recaptureAudio(session: FirefoxSession, reason: string): void {
    if (firefoxSession !== session || session.cancelled || !session.audioCtx || !session.audioMixer) return;
    const now = Date.now();
    if (now - session.lastRecaptureAt < MIN_RECAPTURE_INTERVAL_MS) return;
    session.lastRecaptureAt = now;
    session.silentChunks = 0;
    const mediaVideo = session.video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const captureMethod = mediaVideo.captureStream || mediaVideo.mozCaptureStream;
    if (!captureMethod) return;
    try {
      const fresh = captureMethod.call(session.video);
      const liveTrack = fresh.getAudioTracks().find(track => track.readyState === 'live');
      if (!liveTrack) {
        for (const track of fresh.getTracks()) track.stop();
        emitDiagnostic('firefox_capture', 'recapture_no_audio', { sessionRef: diagnosticSessionRef(session.sessionId), reason });
        return;
      }
      // Gắn đúng track đang sống: MediaStreamSource của stream nhiều track có thể chọn nhầm track đã chết.
      const node = session.audioCtx.createMediaStreamSource(new MediaStream([liveTrack]));
      session.audioMixer.replaceCaptureSource(node);
      const previous = session.captureStream;
      session.captureStream = fresh;
      watchCaptureStream(session, fresh);
      if (previous && previous !== fresh) {
        for (const track of previous.getTracks()) track.stop();
      }
      emitDiagnostic('firefox_capture', 'recaptured', { sessionRef: diagnosticSessionRef(session.sessionId), reason });
    } catch (error) {
      emitDiagnostic('firefox_capture', 'recapture_failed', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        reason,
        errorLength: String(error).length
      });
    }
  }

  async function connectFirefoxWebSocket(session: FirefoxSession): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(createRuntimeError('WS_CONNECTION_TIMEOUT', 'Hết thời gian chờ phản hồi từ máy chủ AI.', true, true));
      }, SESSION_READY_TIMEOUT_MS);

      try {
        // WebSocket mở từ content script mang Origin của trang (bị backend từ chối); đi qua relay ở background.
        session.ws = new RelaySocket(session.wsUrl, chrome.runtime.connect({ name: WS_RELAY_PORT_NAME }) as any);
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
          emitDiagnostic('firefox_ws', 'session_start_sent', { sessionRef: diagnosticSessionRef(session.sessionId) });
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
        const reason = (event as { reason?: unknown } | null)?.reason;
        console.error('[CONTENT] WebSocket error', JSON.stringify({ code: error.code, message: typeof reason === 'string' ? reason : String(event) }));
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
            emitDiagnostic('firefox_ws', 'session_ready_received', { sessionRef: diagnosticSessionRef(session.sessionId) });
            resolve();
          } else if (message.type === 'ERROR' && message.fatal && !settled) {
            // Backend từ chối phiên: báo đúng mã lỗi thay vì chờ timeout rồi báo mất kết nối.
            settled = true;
            clearTimeout(timeout);
            reject(createRuntimeError(message.code, message.message, isRetryableServerError(message.code), true));
            return;
          }
          emitDiagnostic('firefox_ws', 'server_event_received', {
            sessionRef: diagnosticSessionRef(session.sessionId),
            type: message.type,
            generation: 'generation' in message ? message.generation : undefined
          });
          void handleFirefoxServerMessage(session, message);
        } catch (error) {
          console.error('[CONTENT] WebSocket message parse failed', JSON.stringify({ code: 'WS_MESSAGE_INVALID', message: String(error) }));
        }
      };
    });
  }

  function showReleasedSubtitle(session: FirefoxSession, item: SyncedSubtitleRelease): void {
    if (firefoxSession !== session || session.cancelled || !subtitleRenderer) return;
    const { message } = item;
    const displayed = subtitleRenderer.showSyncedSubtitle(
      message.segmentId,
      message.text,
      item.ttsDurationMs,
      message.generation,
      { startMs: message.startMs, endMs: message.endMs }
    );
    emitDiagnostic('firefox_ws', 'subtitle_event_rendered', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      displayed,
      syncedWithTts: item.ttsDurationMs !== undefined,
      textLength: message.text.length
    });
  }

  async function handleFirefoxServerMessage(session: FirefoxSession, message: ServerMessage): Promise<void> {
    if (firefoxSession !== session || session.cancelled) return;
    if (message.type === 'LATENCY_METRIC') notifyBackground(message);
    if (message.type === 'ERROR') {
      notifyBackground(message);
      // Chỉ lỗi nghiêm trọng mới dừng phiên; lỗi tạm thời được background hiển thị như cảnh báo.
      if (message.fatal) {
        await failFirefoxSession(session, createRuntimeError(message.code, message.message, isRetryableServerError(message.code), true));
      }
      return;
    }
    if (message.type === 'SCRIPT_SENTENCES') {
      session.punctuationWaiters.get(message.requestId)?.(message.segments);
      return;
    }
    if (session.script && (message.type === 'SUBTITLE_EVENT' || message.type === 'TTS_CHUNK') && message.scheduled) {
      if (message.generation !== session.generation) return;
      if (message.type === 'SUBTITLE_EVENT') session.script.handleSubtitle(message);
      else {
        try {
          await session.script.handleTts(message);
        } catch (error) {
          emitDiagnostic('firefox_script', 'audio_decode_failed', {
            sessionRef: diagnosticSessionRef(session.sessionId),
            errorLength: String(error).length
          });
        }
      }
      return;
    }
    if (message.type === 'SUBTITLE_EVENT') {
      emitDiagnostic('firefox_ws', 'subtitle_event_received', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        hasRenderer: Boolean(subtitleRenderer),
        hasText: Boolean(message.text),
        textLength: message.text.length,
        action: message.action
      });
    }
    if (message.type === 'SUBTITLE_EVENT' && message.action === 'show' && session.subtitleSync?.offer(message)) {
      // Phụ đề chờ giọng đọc cùng câu (TTS_CHUNK tới ngay sau) để hiện đúng lúc giọng đọc bắt đầu.
      emitDiagnostic('firefox_ws', 'subtitle_held_for_tts', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        segmentId: message.segmentId
      });
    } else if (message.type === 'SUBTITLE_EVENT' && subtitleRenderer && message.action === 'show') {
      const displayed = subtitleRenderer.showSubtitle(
        message.segmentId,
        message.text,
        resolveSubtitleDisplayDurationMs(message.startMs, message.endMs),
        message.generation,
        { startMs: message.startMs, endMs: message.endMs }
      );
      emitDiagnostic('firefox_ws', 'subtitle_event_rendered', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        displayed,
        textLength: message.text.length
      });
    }
    if (message.type === 'TTS_CHUNK' && message.generation === session.generation && session.audioCtx && session.audioMixer && TtsStreamReceiver.handles(message)) {
      session.ttsReceiver ??= new TtsStreamReceiver({
        audioCtx: session.audioCtx,
        mixer: session.audioMixer,
        getSubtitleSync: () => session.subtitleSync ?? undefined,
        onSource: source => session.syncController?.setActiveTTSSource(source),
        diagScope: 'firefox_tts'
      });
      session.ttsReceiver.handle(message);
      return;
    }
    if (message.type === 'TTS_CHUNK' && message.generation === session.generation && session.audioCtx && session.audioMixer) {
      const playbackEpochAtDecodeStart = session.playbackEpoch;
      try {
        const binary = atob(message.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const audioBuffer = await session.audioCtx.decodeAudioData(bytes.buffer);
        if (firefoxSession === session && !session.cancelled && message.generation === session.generation && playbackEpochAtDecodeStart === session.playbackEpoch && session.audioMixer) {
          const scheduled = session.audioMixer.scheduleTTSBuffer(audioBuffer, undefined, ttsSlotMs(message));
          if (scheduled) {
            session.syncController?.setActiveTTSSource(scheduled.source);
            session.subtitleSync?.ttsScheduled(message.segmentId, scheduled.delayMs, scheduled.durationMs, ttsTotalDisplayMs(message, scheduled.durationMs));
          } else {
            session.subtitleSync?.ttsDropped(message.segmentId);
          }
          const videoMs = Math.round(session.video.currentTime * 1000);
          emitDiagnostic('firefox_tts', 'decoded_and_played', {
            sessionRef: diagnosticSessionRef(session.sessionId),
            segmentId: message.segmentId,
            generation: message.generation,
            durationMs: Math.round(audioBuffer.duration * 1000),
            scheduled: Boolean(scheduled),
            delayMs: scheduled?.delayMs,
            // Độ trễ giọng đọc so với câu gốc trên video tại thời điểm giọng đọc bắt đầu.
            lagFromStartMs: scheduled ? videoMs + scheduled.delayMs - message.startMs : undefined,
            lagFromEndMs: scheduled ? videoMs + scheduled.delayMs - message.endMs : undefined
          });
        }
      } catch (error) {
        session.subtitleSync?.ttsDropped(message.segmentId);
        emitDiagnostic('firefox_tts', 'decoder_or_playback_error', {
          sessionRef: diagnosticSessionRef(session.sessionId),
          generation: message.generation
        });
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
    session.playbackEpoch += 1;
    await cleanupFirefoxSession(session, reason);
  }

  async function cleanupFirefoxSession(session: FirefoxSession, reason: string): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupPromise = (async () => {
      emitDiagnostic('firefox_capture', 'cleanup_started', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        reasonLength: reason.length
      });
      if (session.pcmProcessor) {
        session.pcmProcessor.stop();
        session.pcmProcessor = null;
      }
      session.script?.destroy();
      session.script = null;
      if (session.audioMixer) {
        session.audioMixer.disconnect();
        session.audioMixer = null;
      }
      session.detachCaptureWatch?.();
      session.detachCaptureWatch = null;
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
      session.subtitleSync?.clear();
      session.syncController?.stopActiveTTS();
      if (session.video === activeVideo) subtitleRenderer?.hideSubtitle();
      emitDiagnostic('firefox_capture', 'cleanup_finished', { sessionRef: diagnosticSessionRef(session.sessionId) });
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
