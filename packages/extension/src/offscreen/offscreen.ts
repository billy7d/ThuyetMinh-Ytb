import { AudioMixer } from '../audio/mixer.js';
import { PCMProcessor } from '../audio/pcm-processor.js';
import {
  ClientMessage,
  ServerMessage,
  OperationMode,
  AudioMixerConfig
} from '@vietdub/shared';

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let audioMixer: AudioMixer | null = null;
let pcmProcessor: PCMProcessor | null = null;
let ws: WebSocket | null = null;
let currentSessionId: string | null = null;
let currentGeneration: number = 1;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'START_CAPTURE':
      startCapture(msg.streamId, msg.sessionId, msg.mode, msg.wsUrl)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
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
  }
});

async function startCapture(
  streamId: string,
  sessionId: string,
  mode: OperationMode,
  wsUrl = 'ws://localhost:8080'
): Promise<void> {
  currentSessionId = sessionId;

  // 1. Obtain Tab Capture MediaStream using Chrome stream ID
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as any,
    video: false
  });

  // 2. Setup AudioContext and AudioMixer
  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  audioMixer = new AudioMixer(audioCtx, sourceNode);

  // 3. Connect WebSocket to Backend and wait for SESSION_READY
  await new Promise<void>((resolve, reject) => {
    let isResolved = false;
    const connectionTimeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        stopCapture();
        reject(new Error('Hết thời gian chờ phản hồi từ máy chủ AI (Timeout). Vui lòng đảm bảo backend đang chạy.'));
      }
    }, 7000);

    try {
      ws = new WebSocket(wsUrl);
    } catch (wsErr: any) {
      clearTimeout(connectionTimeout);
      reject(new Error(`Không thể kết nối đến máy chủ WebSocket (${wsUrl}): ${wsErr.message}`));
      return;
    }

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

    ws.onerror = (err) => {
      console.error('[Offscreen] WebSocket error:', err);
      if (!isResolved) {
        isResolved = true;
        clearTimeout(connectionTimeout);
        stopCapture();
        reject(new Error('Không thể kết nối với máy chủ xử lý thuyết minh (ws://localhost:8080). Vui lòng kiểm tra backend.'));
      }
    };

    ws.onclose = (ev) => {
      console.log(`[Offscreen] WebSocket closed (${ev.code}): ${ev.reason}`);
      if (!isResolved) {
        isResolved = true;
        clearTimeout(connectionTimeout);
        stopCapture();
        reject(new Error('Máy chủ WebSocket đã đóng kết nối trước khi khởi tạo phiên thành công.'));
      }
    };

    ws.onmessage = async (event) => {
      try {
        const serverMsg = JSON.parse(event.data) as ServerMessage;
        if (serverMsg.type === 'SESSION_READY') {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(connectionTimeout);
            resolve();
          }
        }
        handleServerMessage(serverMsg);
      } catch (err) {
        console.error('[Offscreen] WS parse error:', err);
      }
    };
  });

  // 4. Setup PCM Streaming from STT Tap
  pcmProcessor = new PCMProcessor(
    audioCtx,
    audioMixer.getSTTTapNode(),
    (pcmBase64, timestampMs) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const chunkMsg: ClientMessage = {
          type: 'AUDIO_CHUNK',
          sessionId,
          timestamp: Date.now(),
          sequence: 0,
          pcmBase64,
          timestampMs
        };
        ws.send(JSON.stringify(chunkMsg));
      }
    }
  );
}

function handleServerMessage(msg: ServerMessage): void {
  // Relay subtitle and metrics events to background/content
  if (msg.type === 'SUBTITLE_EVENT' || msg.type === 'LATENCY_METRIC' || msg.type === 'ERROR') {
    chrome.runtime.sendMessage({ target: 'background', ...msg });
  }

  // Play TTS audio
  if (msg.type === 'TTS_CHUNK') {
    if (msg.generation === currentGeneration && audioCtx && audioMixer) {
      playTTSChunk(msg.audioBase64);
    }
  }
}

async function playTTSChunk(audioBase64: string): Promise<void> {
  if (!audioCtx || !audioMixer) return;

  try {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
    audioMixer.playTTSBuffer(audioBuffer);
  } catch (err) {
    console.error('[Offscreen] TTS play error:', err);
  }
}

function updateMixer(config: Partial<AudioMixerConfig>): void {
  if (!audioMixer) return;
  if (config.originalVolume !== undefined) audioMixer.setOriginalVolume(config.originalVolume);
  if (config.originalMuted !== undefined) audioMixer.setOriginalMuted(config.originalMuted);
  if (config.ttsVolume !== undefined) audioMixer.setTTSVolume(config.ttsVolume);
}

function handleSeek(fromMs: number, toMs: number): void {
  currentGeneration++;
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
    const modeMsg: ClientMessage = {
      type: 'MODE_CHANGE',
      sessionId: currentSessionId,
      timestamp: Date.now(),
      mode
    };
    ws.send(JSON.stringify(modeMsg));
  }
}

function stopCapture(): void {
  if (pcmProcessor) {
    pcmProcessor.stop();
    pcmProcessor = null;
  }

  if (audioMixer) {
    audioMixer.disconnect();
    audioMixer = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  if (ws) {
    if (ws.readyState === WebSocket.OPEN && currentSessionId) {
      ws.send(JSON.stringify({
        type: 'SESSION_STOP',
        sessionId: currentSessionId,
        timestamp: Date.now()
      }));
    }
    ws.close();
    ws = null;
  }

  currentSessionId = null;
}
