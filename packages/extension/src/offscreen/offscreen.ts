import { AudioMixer } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import {
  ClientMessage,
  ServerMessage,
  OperationMode,
  AudioMixerConfig,
  VideoPlaybackState
} from '@vietdub/shared';

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let audioMixer: AudioMixer | null = null;
let pcmProcessor: PCMProcessor | null = null;
let ws: WebSocket | null = null;
let currentSessionId: string | null = null;
let currentGeneration = 1;
let sequence = 0;
let latestVideoState: VideoPlaybackState | null = null;
let videoStateAudioTime = 0;
let playbackEpoch = 1;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.sessionId, msg.mode, msg.wsUrl)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse({ success: true });
      return true;
    case 'UPDATE_MIXER':
      updateMixer(msg.config);
      sendResponse({ success: true });
      return true;
    case 'SEEK_EVENT':
      handleSeek(msg.fromMs, msg.toMs);
      sendResponse({ success: true });
      return true;
    case 'MODE_CHANGE':
      handleModeChange(msg.mode);
      sendResponse({ success: true });
      return true;
    case 'VIDEO_STATE_UPDATE':
      handleVideoStateUpdate(msg.state);
      sendResponse({ success: true });
      return true;
  }
});

async function startCapture(
  streamId: string,
  sessionId: string,
  mode: OperationMode,
  wsUrl = 'ws://localhost:8080'
): Promise<void> {
  stopCapture();
  currentSessionId = sessionId;
  currentGeneration = 1;
  sequence = 0;
  playbackEpoch++;
  latestVideoState = null;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as any,
    video: false
  });

  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  await audioCtx.resume();
  const sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  audioMixer = new AudioMixer(audioCtx, sourceNode);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const startMsg: ClientMessage = {
      type: 'SESSION_START',
      sessionId,
      timestamp: Date.now(),
      mode,
      audioSampleRate: 16000
    };
    ws?.send(JSON.stringify(startMsg));
  };

  ws.onmessage = event => {
    try {
      handleServerMessage(JSON.parse(event.data) as ServerMessage);
    } catch (error) {
      console.error('[Offscreen] WS parse error:', error);
    }
  };

  ws.onerror = () => handleBackendFailure('BACKEND_CONNECTION_ERROR', 'Không thể kết nối đến máy chủ AI.');
  ws.onclose = () => handleBackendFailure('BACKEND_DISCONNECTED', 'Máy chủ AI đã ngắt kết nối; audio capture đã dừng.');

  pcmProcessor = new PCMProcessor(
    audioCtx,
    audioMixer.getSTTTapNode(),
    (pcmBase64, videoTimeMs) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !currentSessionId) return;
      const chunkMsg: ClientMessage = {
        type: 'AUDIO_CHUNK',
        sessionId: currentSessionId,
        timestamp: Date.now(),
        sequence: sequence++,
        pcmBase64,
        videoTimeMs,
        audioTimeMs: Math.round(audioCtx?.currentTime ? audioCtx.currentTime * 1000 : 0)
      };
      ws.send(JSON.stringify(chunkMsg));
    },
    16000,
    4096,
    getVideoTimeMs
  );
}

function handleServerMessage(msg: ServerMessage): void {
  if (msg.sessionId !== currentSessionId) return;
  if (msg.type === 'SUBTITLE_EVENT' || msg.type === 'LATENCY_METRIC' || msg.type === 'ERROR') {
    chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
  }
  if (
    msg.type === 'TTS_CHUNK' &&
    msg.generation === currentGeneration &&
    audioCtx &&
    audioMixer &&
    !latestVideoState?.paused &&
    msg.endMs >= getVideoTimeMs() - 6000 &&
    audioMixer.getTTSBacklogMs() < 8000
  ) {
    void playTTSChunk(msg.audioBase64, msg.generation, playbackEpoch);
  }
}

async function playTTSChunk(audioBase64: string, generation: number, epoch: number): Promise<void> {
  if (!audioCtx || !audioMixer) return;
  try {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
    if (currentSessionId && generation === currentGeneration && epoch === playbackEpoch && !latestVideoState?.paused) {
      audioMixer.playTTSBuffer(audioBuffer);
    }
  } catch (error) {
    console.error('[Offscreen] TTS play error:', error);
  }
}

function updateMixer(config: Partial<AudioMixerConfig>): void {
  if (!audioMixer) return;
  if (config.originalVolume !== undefined) audioMixer.setOriginalVolume(config.originalVolume);
  if (config.originalMuted !== undefined) audioMixer.setOriginalMuted(config.originalMuted);
  if (config.ttsVolume !== undefined) audioMixer.setTTSVolume(config.ttsVolume);
}

function handleVideoStateUpdate(state: VideoPlaybackState): void {
  latestVideoState = state;
  videoStateAudioTime = audioCtx?.currentTime || 0;
  if (state.paused) {
    playbackEpoch++;
    audioMixer?.stopTTS();
  }
}

function getVideoTimeMs(): number {
  if (!latestVideoState) return Math.round((audioCtx?.currentTime || 0) * 1000);
  if (latestVideoState.paused) return Math.round(latestVideoState.currentTime * 1000);
  const audioDeltaMs = ((audioCtx?.currentTime || videoStateAudioTime) - videoStateAudioTime) * 1000;
  return Math.max(0, Math.round(latestVideoState.currentTime * 1000 + audioDeltaMs * latestVideoState.playbackRate));
}

function handleSeek(fromMs: number, toMs: number): void {
  currentGeneration++;
  audioMixer?.stopTTS();
  if (ws && ws.readyState === WebSocket.OPEN && currentSessionId) {
    const seekMsg: ClientMessage = {
      type: 'SEEK_EVENT',
      sessionId: currentSessionId,
      timestamp: Date.now(),
      fromMs,
      toMs,
      generation: currentGeneration
    };
    ws.send(JSON.stringify(seekMsg));
  }
}

function handleModeChange(mode: OperationMode): void {
  if (ws && ws.readyState === WebSocket.OPEN && currentSessionId) {
    ws.send(JSON.stringify({ type: 'MODE_CHANGE', sessionId: currentSessionId, timestamp: Date.now(), mode } satisfies ClientMessage));
  }
}

function stopCapture(): void {
  const sessionId = currentSessionId;
  const socket = ws;
  currentSessionId = null;
  latestVideoState = null;
  playbackEpoch++;
  if (socket && socket.readyState === WebSocket.OPEN && sessionId) {
    socket.send(JSON.stringify({ type: 'SESSION_STOP', sessionId, timestamp: Date.now() } satisfies ClientMessage));
  }
  pcmProcessor?.stop();
  pcmProcessor = null;
  audioMixer?.disconnect();
  audioMixer = null;
  mediaStream?.getTracks().forEach(track => track.stop());
  mediaStream = null;
  if (audioCtx) {
    void audioCtx.close();
    audioCtx = null;
  }
  if (socket) {
    try { socket.close(1000, 'session stopped'); } catch {}
    if (ws === socket) ws = null;
  }
  currentGeneration++;
}

function handleBackendFailure(code: string, message: string): void {
  const sessionId = currentSessionId;
  if (!sessionId) return;
  chrome.runtime.sendMessage({
    target: 'background',
    type: 'ERROR',
    sessionId,
    timestamp: Date.now(),
    code,
    message,
    fatal: true
  }).catch(() => {});
  stopCapture();
}
