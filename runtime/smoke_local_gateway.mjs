// Kiểm tra gateway local bằng audio model thật; chỉ lưu metadata, không lưu transcript.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = path.resolve(process.env.VIETDUB_INSTALL_ROOT || 'E:\\VietDub-AI');
const evidenceRoot = path.join(installRoot, 'evidence');
const sourceWavPath = path.join(evidenceRoot, 'stt-english-synthetic-source.wav');
const ffmpeg = 'D:\\ffmpeg-essentials_build\\ffmpeg-2026-06-15-git-44d082edc8-essentials_build\\bin\\ffmpeg.exe';
const wsUrl = process.env.VIETDUB_WS_URL || 'ws://127.0.0.1:8080';

if (process.platform === 'win32' && path.parse(installRoot).root.toUpperCase() !== 'E:\\') {
  throw new Error('Audio nguồn và evidence gateway phải nằm trên ổ E:.');
}

function resampleToPcm16k(wav) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'wav', '-i', 'pipe:0',
      '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`Không chuyển được audio nguồn sang PCM 16 kHz (${code}): ${Buffer.concat(errors).toString('utf8').slice(0, 200)}`));
    });
    child.stdin.end(wav);
  });
}

function createInbox(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });
  return (predicate, timeoutMs) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const current = waiters.indexOf(waiter);
        if (current >= 0) waiters.splice(current, 1);
        reject(new Error(`Không nhận được phản hồi gateway trong ${timeoutMs} ms.`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

function classifyLocalError(message) {
  // Chỉ lưu loại lỗi ổn định, không ghi nguyên văn dữ liệu có thể chứa nội dung phiên.
  if (/model path does not match/i.test(message)) return 'MODEL_PATH_MISMATCH';
  if (/queue exceeded|backpressure/i.test(message)) return 'WORKER_BACKPRESSURE';
  if (/timed out/i.test(message)) return 'WORKER_TIMEOUT';
  if (/pcm|sample rate|duration/i.test(message)) return 'AUDIO_FORMAT_ERROR';
  if (/stream is not started|session/i.test(message)) return 'STREAM_STATE_ERROR';
  return 'LOCAL_INFERENCE_ERROR';
}

async function main() {
  const healthResponse = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5000) });
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.status !== 'ok' || health.providers?.mode !== 'local' || !health.providers?.configured) {
    throw new Error('Backend local chưa sẵn sàng; không gửi audio gateway.');
  }

  const sourceWav = await readFile(sourceWavPath);
  const pcm = await resampleToPcm16k(sourceWav);
  if (pcm.length < 16_000 || pcm.length > 512 * 1024 || pcm.length % 2) throw new Error('PCM nguồn không hợp lệ.');
  const sessionId = `vietdub-gateway-${Date.now()}`;
  const socket = new WebSocket(wsUrl);
  activeSocket = socket;
  const report = {
    startedAt: new Date().toISOString(),
    endpoint: 'loopback-only',
    sourceAudio: 'VieNeu local model generated English speech; not human-recorded.',
    modelRevisions: Object.fromEntries(Object.entries(health.providers.localModels.components).map(([key, value]) => [key, value.revision])),
    input: { sampleRate: 16_000, channels: 1, pcmBytes: pcm.length, durationMs: Math.round(pcm.length / 2 / 16_000 * 1000) },
    messages: { ready: false, subtitle: false, tts: false, error: false },
    pipelineLatency: [],
    measuredLatency: {}
  };

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const waitFor = createInbox(socket);
  const readyPromise = waitFor(message => message.type === 'SESSION_READY' || message.type === 'ERROR', 15_000);
  socket.send(JSON.stringify({
    type: 'SESSION_START', sessionId, timestamp: Date.now(), mode: 'dubbing_and_subtitle', audioSampleRate: 16_000
  }));
  const ready = await readyPromise;
  if (ready.type !== 'SESSION_READY') throw new Error(`Gateway session did not become ready (${ready.code || 'ERROR'}).`);
  report.messages.ready = true;

  const chunkBytes = 8_000;
  const audioStartedAt = performance.now();
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    socket.send(JSON.stringify({
      type: 'AUDIO_CHUNK', sessionId, timestamp: Date.now(), sequence,
      pcmBase64: chunk.toString('base64'), videoTimeMs: Math.round(offset / 2 / 16_000 * 1000)
    }));
    sequence += 1;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const silence = Buffer.alloc(16_000);
  for (let tail = 0; tail < 2; tail += 1) {
    socket.send(JSON.stringify({
      type: 'AUDIO_CHUNK', sessionId, timestamp: Date.now(), sequence,
      pcmBase64: silence.toString('base64'), videoTimeMs: report.input.durationMs + tail * 250
    }));
    sequence += 1;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const deadline = Date.now() + 30_000;
  const ttsResults = [];
  while (Date.now() < deadline && !(report.messages.subtitle && report.messages.tts)) {
    let message;
    try {
      message = await waitFor(item => [
        'SUBTITLE_EVENT', 'TTS_CHUNK', 'LATENCY_METRIC', 'ERROR'
      ].includes(item.type), Math.max(1, deadline - Date.now()));
    } catch {
      report.eventWaitTimedOut = true;
      break;
    }
    if (message.type === 'SUBTITLE_EVENT' && typeof message.text === 'string' && message.text.trim()) {
      report.messages.subtitle = true;
      if (Number.isFinite(message.endMs)) {
        report.measuredLatency.subtitleFromSegmentEndMs ??= Math.round(performance.now() - audioStartedAt - message.endMs);
      }
      report.subtitle = {
        translated: /[\u00C0-\u024F\u1EA0-\u1EFF]/u.test(message.text),
        characters: message.text.length,
        hasShowAction: message.action === 'show'
      };
    } else if (message.type === 'TTS_CHUNK') {
      report.measuredLatency.ttsFromAudioStartMs ??= Math.round(performance.now() - audioStartedAt);
      if (Number.isFinite(message.endMs)) {
        report.measuredLatency.ttsFromSegmentEndMs ??= Math.round(performance.now() - audioStartedAt - message.endMs);
      }
      const wav = Buffer.from(message.audioBase64 || '', 'base64');
      let rms = 0;
      if (wav.length > 44) {
        let squareSum = 0;
        let sampleCount = 0;
        for (let offset = 44; offset + 1 < wav.length; offset += 2) {
          const sample = wav.readInt16LE(offset) / 32768;
          squareSum += sample * sample;
          sampleCount += 1;
        }
        rms = Math.sqrt(squareSum / Math.max(sampleCount, 1));
      }
      const valid = wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' &&
        wav.readUInt32LE(24) === 48_000 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16 && rms > 0.005;
      ttsResults.push({ valid, bytes: wav.length, durationMs: message.durationMs, rms });
      report.messages.tts = ttsResults.some(item => item.valid);
    } else if (message.type === 'LATENCY_METRIC') {
      report.pipelineLatency.push({ sttMs: message.sttMs, translationMs: message.translationMs, ttsMs: message.ttsMs, totalMs: message.totalPipelineMs });
    } else if (message.type === 'ERROR') {
      report.messages.error = true;
      report.errorCode = message.code;
      report.errorCategory = classifyLocalError(typeof message.message === 'string' ? message.message : '');
      break;
    }
  }

  if (report.messages.subtitle && report.messages.tts && report.pipelineLatency.length === 0) {
    try {
      const metric = await waitFor(item => item.type === 'LATENCY_METRIC' || item.type === 'ERROR', 2_000);
      if (metric.type === 'LATENCY_METRIC') {
        report.pipelineLatency.push({ sttMs: metric.sttMs, translationMs: metric.translationMs, ttsMs: metric.ttsMs, totalMs: metric.totalPipelineMs });
      }
    } catch {
      report.backendLatencyMetric = 'NOT_RECEIVED';
    }
  }

  const stopPromise = waitFor(message => message.type === 'SESSION_METRICS' || message.type === 'ERROR', 5000);
  socket.send(JSON.stringify({ type: 'SESSION_STOP', sessionId, timestamp: Date.now(), reason: 'local-gateway-smoke' }));
  try {
    const stopMessage = await stopPromise;
    report.zeroCost = stopMessage.type === 'SESSION_METRICS' && stopMessage.metrics?.estimatedCostUsd === 0;
  } catch {
    report.zeroCost = false;
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  socket.close();
  activeSocket = undefined;
  report.ttsChunks = ttsResults;
  report.pipeline = report.messages.ready && report.messages.subtitle && report.subtitle?.translated && report.messages.tts
    ? 'PASS_REAL_MODELS_SYNTHETIC_AUDIO'
    : 'FAIL_OR_INCOMPLETE';
  report.completedAt = new Date().toISOString();
  const reportPath = path.join(evidenceRoot, `local-gateway-smoke-${Date.now()}.json`);
  console.log(JSON.stringify({ ...report, reportPath }));
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}

let activeSocket;
main().catch(error => {
  if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
