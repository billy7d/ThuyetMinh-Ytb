import { AudioMixer } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import {
  AudioMixerConfig,
  ClientMessage,
  DEFAULT_ORIGINAL_VOLUME,
  DEFAULT_TTS_VOLUME,
  OperationMode,
  ServerMessage,
  VideoPlaybackState,
  diagnosticSessionRef,
  emitDiagnostic
} from '@vietdub/shared';

interface RuntimeResponse {
  success: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
}

interface OffscreenSession {
  sessionId: string;
  mode: OperationMode;
  wsUrl: string;
  generation: number;
  sequence: number;
  cancelled: boolean;
  ready: boolean;
  failureNotified: boolean;
  audioCtx: AudioContext | null;
  mediaStream: MediaStream | null;
  audioMixer: AudioMixer | null;
  pcmProcessor: PCMProcessor | null;
  ws: WebSocket | null;
  cleanupPromise: Promise<void> | null;
}

let currentSession: OffscreenSession | null = null;
let startFlight: Promise<void> | null = null;

function runtimeError(code: string, message: string, retryable = false, fatal = true): Error & {
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

function isCurrent(session: OffscreenSession): boolean {
  return currentSession === session && !session.cancelled;
}

function assertCurrent(session: OffscreenSession): void {
  if (!isCurrent(session)) throw runtimeError('SESSION_CANCELLED', 'Phiên khởi tạo đã bị hủy.', false, false);
}

function notifyBackground(message: unknown): void {
  try {
    const result = chrome.runtime.sendMessage({ target: 'background', ...message as object });
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((error) => {
        console.debug('[Offscreen] background notification failed', JSON.stringify({ code: 'BACKGROUND_NOTIFY_FAILED', message: String(error) }));
      });
    }
  } catch (error) {
    console.error('[Offscreen] background notification failed', JSON.stringify({ code: 'BACKGROUND_NOTIFY_FAILED', message: String(error) }));
  }
}

function defaultMixerConfig(config?: Partial<AudioMixerConfig>): AudioMixerConfig {
  const originalVolume = config?.originalVolume;
  const ttsVolume = config?.ttsVolume;
  return {
    originalVolume: typeof originalVolume === 'number' && Number.isFinite(originalVolume) ? originalVolume : DEFAULT_ORIGINAL_VOLUME,
    originalMuted: config?.originalMuted === true,
    ttsVolume: typeof ttsVolume === 'number' && Number.isFinite(ttsVolume) ? ttsVolume : DEFAULT_TTS_VOLUME
  };
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'GET_STATUS':
      sendResponse({
        active: currentSession !== null,
        sessionId: currentSession?.sessionId || null,
        hasAudioContext: currentSession?.audioCtx !== null && currentSession?.audioCtx !== undefined,
        hasPcmProcessor: currentSession?.pcmProcessor !== null && currentSession?.pcmProcessor !== undefined,
        websocketState: currentSession?.ws?.readyState ?? WebSocket.CLOSED
      });
      return false;

    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.sessionId, msg.mode, msg.mixerConfig, msg.wsUrl)
        .then(() => sendResponse({ success: true }))
        .catch((error) => {
          const code = error?.code || 'CHROME_START_FAILED';
          sendResponse({ success: false, code, retryable: error?.retryable === true, error: error?.message || String(error) });
        });
      return true;

    case 'STOP_CAPTURE':
      stopCapture(msg.sessionId, msg.reason || 'user')
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, code: 'OFFSCREEN_STOP_FAILED', error: String(error) }));
      return true;

    case 'UPDATE_MIXER':
      updateMixer(msg.config || {});
      sendResponse({ success: true });
      return false;

    case 'SEEK_EVENT':
      handleSeek(msg.fromMs, msg.toMs, msg.sessionId);
      sendResponse({ success: true });
      return false;

    case 'VIDEO_STATE_UPDATE':
      handleVideoState(msg.state, msg.sessionId);
      sendResponse({ success: true });
      return false;

    case 'MODE_CHANGE':
      handleModeChange(msg.mode, msg.sessionId);
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

async function startCapture(
  streamId: string,
  sessionId: string,
  mode: OperationMode = 'dubbing_and_subtitle',
  mixerConfig?: Partial<AudioMixerConfig>,
  wsUrl = 'ws://localhost:8080'
): Promise<void> {
  if (!streamId || !sessionId) throw runtimeError('INVALID_START_REQUEST', 'Thiếu streamId hoặc sessionId.');
  emitDiagnostic('chrome_capture', 'start_requested', {
    sessionRef: diagnosticSessionRef(sessionId),
    mode
  });

  if (currentSession?.sessionId === sessionId && startFlight) return startFlight;
  if (currentSession) await stopCapture(currentSession.sessionId, 'replaced-by-new-start');

  const session: OffscreenSession = {
    sessionId,
    mode,
    wsUrl,
    generation: 1,
    sequence: 0,
    cancelled: false,
    ready: false,
    failureNotified: false,
    audioCtx: null,
    mediaStream: null,
    audioMixer: null,
    pcmProcessor: null,
    ws: null,
    cleanupPromise: null
  };
  currentSession = session;

  const flight = runStartCapture(session, streamId, defaultMixerConfig(mixerConfig));
  startFlight = flight;
  flight.then(
    () => {
      if (startFlight === flight) startFlight = null;
    },
    () => {
      if (startFlight === flight) startFlight = null;
    }
  );
  return flight;
}

async function runStartCapture(session: OffscreenSession, streamId: string, mixerConfig: AudioMixerConfig): Promise<void> {
  try {
    session.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      } as any,
      video: false
    });
    assertCurrent(session);
    emitDiagnostic('chrome_capture', 'media_stream_ready', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      audioTracks: session.mediaStream.getAudioTracks().length,
      totalTracks: session.mediaStream.getTracks().length
    });

    session.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (session.audioCtx.state === 'suspended') await session.audioCtx.resume();
    assertCurrent(session);
    emitDiagnostic('chrome_capture', 'audio_context_ready', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      state: session.audioCtx.state,
      sampleRate: session.audioCtx.sampleRate
    });

    const sourceNode = session.audioCtx.createMediaStreamSource(session.mediaStream);
    session.audioMixer = new AudioMixer(session.audioCtx, sourceNode, {
      sourceMode: 'media-stream',
      initialConfig: mixerConfig
    });
    emitDiagnostic('chrome_capture', 'audio_graph_ready', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      sourceMode: 'media-stream'
    });

    await connectWebSocket(session);
    assertCurrent(session);

    // Chỉ bắt đầu gửi PCM sau SESSION_READY từ backend.
    session.pcmProcessor = new PCMProcessor(
      session.audioCtx,
      session.audioMixer.getSTTTapNode(),
      (pcmBase64, timestampMs) => {
        if (!isCurrent(session) || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
        const message: ClientMessage = {
          type: 'AUDIO_CHUNK',
          sessionId: session.sessionId,
          timestamp: Date.now(),
          sequence: session.sequence++,
          pcmBase64,
          timestampMs
        };
        try {
          session.ws.send(JSON.stringify(message));
        } catch (error) {
          void failSession(session, runtimeError('AUDIO_SEND_FAILED', String(error), true, true));
        }
      },
      16000,
      4096,
      session.sessionId
    );
    assertCurrent(session);
    session.ready = true;
    notifyBackground({ type: 'SESSION_RUNTIME', sessionId: session.sessionId, state: 'ACTIVE' });
  } catch (error) {
    await cleanupSession(session, 'start-failed');
    throw error;
  }
}

async function connectWebSocket(session: OffscreenSession): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(runtimeError('WS_CONNECTION_TIMEOUT', 'Hết thời gian chờ phản hồi từ máy chủ AI.', true, true));
    }, 7000);

    try {
      session.ws = new WebSocket(session.wsUrl);
    } catch (error) {
      clearTimeout(timeout);
      reject(runtimeError('WS_CONNECTION_FAILED', `Không thể kết nối máy chủ WebSocket: ${String(error)}`, true, true));
      return;
    }

    const socket = session.ws;
    socket.onopen = () => {
      if (!isCurrent(session)) return;
      const startMessage: ClientMessage = {
        type: 'SESSION_START',
        sessionId: session.sessionId,
        timestamp: Date.now(),
        mode: session.mode,
        audioSampleRate: 16000
      };
      try {
        socket.send(JSON.stringify(startMessage));
        emitDiagnostic('chrome_ws', 'session_start_sent', { sessionRef: diagnosticSessionRef(session.sessionId) });
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(runtimeError('WS_SEND_FAILED', String(error), true, true));
        }
      }
    };

    socket.onerror = (error) => {
      const wsError = runtimeError('WS_CONNECTION_FAILED', 'Không thể kết nối máy chủ xử lý thuyết minh.', true, true);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(wsError);
      } else if (isCurrent(session)) {
        void failSession(session, wsError);
      }
      console.error('[Offscreen] WebSocket error', JSON.stringify({ code: wsError.code, message: String(error) }));
    };

    socket.onclose = (event) => {
      const closeError = runtimeError(
        'WS_DISCONNECTED',
        'Máy chủ WebSocket đã ngắt kết nối.',
        true,
        true
      );
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(closeError);
      } else if (isCurrent(session)) {
        void failSession(session, closeError);
      }
      console.log('[Offscreen] WebSocket closed', JSON.stringify({ code: event.code, reason: event.reason }));
    };

    socket.onmessage = (event) => {
      if (!isCurrent(session)) return;
      try {
        const serverMessage = JSON.parse(String(event.data)) as ServerMessage;
        if (serverMessage.sessionId !== session.sessionId) return;
        if (serverMessage.type === 'SESSION_READY' && !settled) {
          settled = true;
          clearTimeout(timeout);
          session.ready = true;
          emitDiagnostic('chrome_ws', 'session_ready_received', { sessionRef: diagnosticSessionRef(session.sessionId) });
          resolve();
        }
        emitDiagnostic('chrome_ws', 'server_event_received', {
          sessionRef: diagnosticSessionRef(session.sessionId),
          type: serverMessage.type,
          generation: 'generation' in serverMessage ? serverMessage.generation : undefined
        });
        void handleServerMessage(session, serverMessage);
      } catch (error) {
        console.error('[Offscreen] WebSocket message parse failed', JSON.stringify({ code: 'WS_MESSAGE_INVALID', message: String(error) }));
      }
    };
  });
}

async function handleServerMessage(session: OffscreenSession, message: ServerMessage): Promise<void> {
  if (!isCurrent(session)) return;

  if (message.type === 'SUBTITLE_EVENT' || message.type === 'LATENCY_METRIC' || message.type === 'SESSION_METRICS') {
    notifyBackground(message);
    emitDiagnostic('chrome_ws', 'event_forwarded_to_background', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      type: message.type,
      textLength: message.type === 'SUBTITLE_EVENT' ? message.text.length : undefined
    });
  }

  if (message.type === 'ERROR') {
    notifyBackground(message);
    if (message.fatal || session.ready) {
      await failSession(session, runtimeError(message.code, message.message, false, message.fatal));
    }
    return;
  }

  if (message.type === 'TTS_CHUNK' && message.generation === session.generation && session.audioCtx && session.audioMixer) {
    try {
      const binary = atob(message.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const audioBuffer = await session.audioCtx.decodeAudioData(bytes.buffer);
      if (isCurrent(session) && message.generation === session.generation && session.audioMixer) {
        session.audioMixer.playTTSBuffer(audioBuffer);
        emitDiagnostic('chrome_tts', 'decoded_and_played', {
          sessionRef: diagnosticSessionRef(session.sessionId),
          generation: message.generation,
          durationMs: Math.round(audioBuffer.duration * 1000)
        });
      }
    } catch (error) {
      emitDiagnostic('chrome_tts', 'decoder_or_playback_error', {
        sessionRef: diagnosticSessionRef(session.sessionId),
        generation: message.generation
      });
      console.error('[Offscreen] TTS playback failed', JSON.stringify({ code: 'TTS_PLAY_FAILED', message: String(error) }));
    }
  }
}

function updateMixer(config: Partial<AudioMixerConfig>): void {
  const session = currentSession;
  if (!session?.audioMixer || !isCurrent(session)) return;
  if (config.originalVolume !== undefined) session.audioMixer.setOriginalVolume(config.originalVolume);
  if (config.originalMuted !== undefined) session.audioMixer.setOriginalMuted(config.originalMuted);
  if (config.ttsVolume !== undefined) session.audioMixer.setTTSVolume(config.ttsVolume);
}

function handleSeek(fromMs: number, toMs: number, sessionId?: string): void {
  const session = currentSession;
  if (!session || !isCurrent(session) || (sessionId && session.sessionId !== sessionId)) return;
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
    session.ws.send(JSON.stringify(message));
  }
}

function handleVideoState(state: VideoPlaybackState, sessionId?: string): void {
  const session = currentSession;
  if (!session || !isCurrent(session) || (sessionId && session.sessionId !== sessionId) || session.ws?.readyState !== WebSocket.OPEN) return;
  const message: ClientMessage = {
    type: 'VIDEO_STATE_UPDATE',
    sessionId: session.sessionId,
    timestamp: Date.now(),
    state
  };
  session.ws.send(JSON.stringify(message));
}

function handleModeChange(mode: OperationMode, sessionId?: string): void {
  const session = currentSession;
  if (!session || !isCurrent(session) || (sessionId && session.sessionId !== sessionId)) return;
  session.mode = mode;
  if (session.ws?.readyState === WebSocket.OPEN) {
    const message: ClientMessage = {
      type: 'MODE_CHANGE',
      sessionId: session.sessionId,
      timestamp: Date.now(),
      mode
    };
    session.ws.send(JSON.stringify(message));
  }
}

async function failSession(session: OffscreenSession, error: Error & { code?: string; retryable?: boolean; fatal?: boolean }): Promise<void> {
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
  await stopCapture(session.sessionId, 'runtime-failure');
}

async function stopCapture(sessionId?: string, reason = 'user'): Promise<void> {
  const session = currentSession;
  if (!session || (sessionId && session.sessionId !== sessionId)) return;
  currentSession = null;
  session.cancelled = true;
  await cleanupSession(session, reason);
}

async function cleanupSession(session: OffscreenSession, reason: string): Promise<void> {
  if (session.cleanupPromise) return session.cleanupPromise;

  session.cleanupPromise = (async () => {
    emitDiagnostic('chrome_capture', 'cleanup_started', {
      sessionRef: diagnosticSessionRef(session.sessionId),
      reasonLength: reason.length
    });
    if (session.pcmProcessor) {
      session.pcmProcessor.stop();
      session.pcmProcessor = null;
    }
    if (session.audioMixer) {
      session.audioMixer.disconnect();
      session.audioMixer = null;
    }
    if (session.mediaStream) {
      for (const track of session.mediaStream.getTracks()) track.stop();
      session.mediaStream = null;
    }
    if (session.audioCtx) {
      try {
        await session.audioCtx.close();
      } catch (error) {
        console.error('[Offscreen] AudioContext close failed', JSON.stringify({ code: 'AUDIO_CONTEXT_CLOSE_FAILED', message: String(error), reason }));
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
          console.warn('[Offscreen] SESSION_STOP send failed', JSON.stringify({ code: 'SESSION_STOP_SEND_FAILED', message: String(error) }));
        }
      }
      try {
        socket.close();
      } catch (error) {
        console.warn('[Offscreen] WebSocket close failed', JSON.stringify({ code: 'WS_CLOSE_FAILED', message: String(error) }));
      }
      session.ws = null;
    }
    session.ready = false;
    emitDiagnostic('chrome_capture', 'cleanup_finished', { sessionRef: diagnosticSessionRef(session.sessionId) });
  })();

  return session.cleanupPromise;
}
