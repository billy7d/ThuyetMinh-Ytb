// Soak test gateway local với model thật: phát audio thời gian thực có nhạc nền, rồi giả lập tải lại trang.
// Chỉ lưu số liệu tổng hợp (không lưu transcript) vào E:\VietDub-AI\evidence.
//
// Dùng: node runtime/soak_local_gateway.mjs [--ws ws://127.0.0.1:8080] [--seconds 60] [--label new]
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const wsUrl = args.get('--ws') || process.env.VIETDUB_WS_URL || 'ws://127.0.0.1:8080';
const streamSeconds = Number(args.get('--seconds') || 60);
const reloadSeconds = Number(args.get('--reload-seconds') || 20);
const label = args.get('--label') || 'run';
// Mô phỏng người nói nhanh/dày: --tempo 1.35 tăng tốc độ nói, --gap giảm khoảng nghỉ giữa các câu mẫu (giây).
const speechTempo = Number(args.get('--tempo') || 1);
const speechGapSeconds = Number(args.get('--gap') || 0.6);
const installRoot = path.resolve(process.env.VIETDUB_INSTALL_ROOT || 'E:\\VietDub-AI');
const evidenceRoot = path.join(installRoot, 'evidence');
const sourceWavPath = path.join(evidenceRoot, 'stt-english-synthetic-source.wav');
const ffmpeg = 'D:\\ffmpeg-essentials_build\\ffmpeg-2026-06-15-git-44d082edc8-essentials_build\\bin\\ffmpeg.exe';
const CHUNK_MS = 250;
const CHUNK_SAMPLES = 16_000 * CHUNK_MS / 1000;

function resampleToPcm16k(wav) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'wav', '-i', 'pipe:0', ...(speechTempo !== 1 ? ['-filter:a', `atempo=${speechTempo}`] : []), '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(`ffmpeg exited ${code}`))));
    child.stdin.end(wav);
  });
}

/** Giọng nói lặp lại + nhạc nền liên tục (hợp âm điều biến) để không có khoảng lặng thật. */
function buildProgram(speech, seconds, musicLevel) {
  const speechSamples = new Int16Array(speech.buffer, speech.byteOffset, speech.length / 2);
  const total = Math.round(seconds * 16_000);
  const out = Buffer.alloc(total * 2);
  const gapSamples = 16_000 * speechGapSeconds;
  const period = speechSamples.length + gapSamples;
  for (let index = 0; index < total; index += 1) {
    const t = index / 16_000;
    const position = index % period;
    const voice = position < speechSamples.length ? speechSamples[position] / 32768 : 0;
    const music = musicLevel * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t)) * (
      Math.sin(2 * Math.PI * 196 * t) + 0.7 * Math.sin(2 * Math.PI * 247 * t) + 0.5 * Math.sin(2 * Math.PI * 294 * t)
    ) / 2.2;
    const sample = Math.max(-1, Math.min(1, voice + music));
    out.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  return out;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function openSession(sessionId) {
  const socket = new WebSocket(wsUrl);
  const messages = [];
  const state = { closedByServer: false, socket, messages, openedAt: Date.now() };
  socket.on('message', raw => {
    try {
      messages.push({ ...JSON.parse(String(raw)), receivedAt: Date.now() });
    } catch {}
  });
  socket.on('close', () => { state.closedByServer = !state.closingByClient; });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'SESSION_START', sessionId, timestamp: Date.now(), mode: 'dubbing_and_subtitle', audioSampleRate: 16_000 }));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = messages.find(message => message.type === 'SESSION_READY' || (message.type === 'ERROR' && message.fatal));
    if (ready) {
      if (ready.type !== 'SESSION_READY') throw new Error(`Session rejected: ${ready.code}`);
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('SESSION_READY timeout');
}

async function stream(state, sessionId, pcm, startVideoMs, durationSeconds) {
  const streamStartedAt = Date.now();
  const totalChunks = Math.floor((durationSeconds * 1000) / CHUNK_MS);
  for (let index = 0; index < totalChunks; index += 1) {
    const offsetSamples = (index * CHUNK_SAMPLES) % Math.floor(pcm.length / 2 - CHUNK_SAMPLES);
    const chunk = pcm.subarray(offsetSamples * 2, (offsetSamples + CHUNK_SAMPLES) * 2);
    if (state.socket.readyState !== WebSocket.OPEN) break;
    state.socket.send(JSON.stringify({
      type: 'AUDIO_CHUNK', sessionId, timestamp: Date.now(), sequence: index,
      pcmBase64: chunk.toString('base64'), videoTimeMs: startVideoMs + index * CHUNK_MS
    }));
    // Giữ nhịp thời gian thực giống trình duyệt.
    const target = streamStartedAt + (index + 1) * CHUNK_MS;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, target - Date.now())));
  }
  return streamStartedAt;
}

/**
 * Mô phỏng hàng chờ phát của AudioMixer trên đúng luồng TTS_CHUNK thu được (cùng công thức với extension).
 * Cho biết bao nhiêu câu thuyết minh bị bỏ vì hàng chờ quá dài và thuyết minh trễ bao lâu so với câu gốc.
 */
function simulateMixer(tts, streamStartedAt, startVideoMs, policy) {
  let nextFree = 0;
  let played = 0;
  let skipped = 0;
  let maxBacklogMs = 0;
  const lagFromEnd = [];
  for (const message of tts) {
    const now = message.receivedAt - streamStartedAt;
    const backlog = Math.max(0, nextFree - now);
    maxBacklogMs = Math.max(maxBacklogMs, backlog);
    if (backlog > policy.limitMs) { skipped += 1; continue; }
    const slotMs = (message.endMs - message.startMs) + 600;
    const slotRate = message.durationMs <= slotMs ? 1 : Math.min(policy.maxRate, message.durationMs / slotMs);
    const rate = Math.max(backlog <= policy.rampStartMs ? 1 : Math.min(policy.maxRate, 1 + (backlog - policy.rampStartMs) / policy.rampSpanMs), slotRate);
    const start = Math.max(now, nextFree);
    nextFree = start + message.durationMs / rate;
    played += 1;
    lagFromEnd.push(start - (message.endMs - startVideoMs));
  }
  const sorted = [...lagFromEnd].sort((a, b) => a - b);
  return { played, skipped, maxBacklogMs: Math.round(maxBacklogMs), dubStartLagFromSentenceEndMs: { p50: sorted[Math.floor(sorted.length * 0.5)] ?? null, p95: sorted[Math.floor(sorted.length * 0.95)] ?? null } };
}

function summarize(state, streamStartedAt, startVideoMs) {
  const subtitles = state.messages.filter(message => message.type === 'SUBTITLE_EVENT');
  const tts = state.messages.filter(message => message.type === 'TTS_CHUNK');
  const errors = state.messages.filter(message => message.type === 'ERROR');
  const metrics = state.messages.filter(message => message.type === 'LATENCY_METRIC');
  // Trễ thật: thời điểm nhận phụ đề so với lúc câu đó kết thúc trên "video" (stream chạy đúng thời gian thực).
  const subtitleLagMs = subtitles.map(message => message.receivedAt - (streamStartedAt + (message.endMs - startVideoMs)));
  const firstError = errors[0];
  const ttsLagMs = tts.map(message => message.receivedAt - (streamStartedAt + (message.endMs - startVideoMs)));
  // Thời điểm bản dịch sẵn sàng = lúc phụ đề hiện ở phiên bản cũ (chưa đồng bộ theo giọng đọc).
  const translationLagMs = state.messages.filter(message => message.type === 'TRANSLATION_READY')
    .map(message => message.receivedAt - (streamStartedAt + (message.endMs - startVideoMs)));
  const ttsBySegment = new Map(tts.map(message => [message.segmentId, message.receivedAt]));
  const subtitleMinusTtsMs = subtitles.filter(message => ttsBySegment.has(message.segmentId))
    .map(message => message.receivedAt - ttsBySegment.get(message.segmentId));
  const stats = values => ({ p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null });
  return {
    mixerPolicyOld: simulateMixer(tts, streamStartedAt, startVideoMs, { limitMs: 3000, maxRate: 1.2, rampStartMs: 1000, rampSpanMs: 10000 }),
    mixerPolicyNew: simulateMixer(tts, streamStartedAt, startVideoMs, { limitMs: 3500, maxRate: 1.3, rampStartMs: 500, rampSpanMs: 8000 }),
    ttsLagMs: stats(ttsLagMs),
    translationReadyLagMs: stats(translationLagMs),
    subtitleMinusTtsMs: { ...stats(subtitleMinusTtsMs), min: subtitleMinusTtsMs.length ? Math.min(...subtitleMinusTtsMs) : null, n: subtitleMinusTtsMs.length },
    subtitles: subtitles.length,
    ttsChunks: tts.length,
    subtitleLagMs: { p50: percentile(subtitleLagMs, 50), p95: percentile(subtitleLagMs, 95), max: subtitleLagMs.length ? Math.max(...subtitleLagMs) : null },
    backendVideoLagMs: { p50: percentile(metrics.map(m => m.videoLagMs).filter(Number.isFinite), 50), p95: percentile(metrics.map(m => m.videoLagMs).filter(Number.isFinite), 95) },
    // Thông báo lỗi pipeline không chứa transcript; cắt ngắn để báo cáo gọn.
    errors: errors.map(error => ({ code: error.code, fatal: error.fatal, atMs: error.receivedAt - streamStartedAt, message: String(error.message || '').slice(0, 160) })),
    // Extension cũ dừng phiên ở BẤT KỲ lỗi nào sau khi sẵn sàng; extension mới chỉ dừng khi fatal.
    oldExtensionWouldStopAtMs: firstError ? firstError.receivedAt - streamStartedAt : null,
    newExtensionWouldStopAtMs: errors.find(error => error.fatal) ? errors.find(error => error.fatal).receivedAt - streamStartedAt : null,
    closedByServer: state.closedByServer,
    firstSubtitleAfterMs: subtitles.length ? subtitles[0].receivedAt - streamStartedAt : null
  };
}

async function main() {
  const speech = await resampleToPcm16k(await readFile(sourceWavPath));
  const program = buildProgram(speech, 90, 0.12);
  const report = { label, wsUrl: 'loopback', startedAt: new Date().toISOString(), streamSeconds, reloadSeconds, source: 'VieNeu synthetic English speech + synthetic continuous music bed' };

  // Pha A: phát liên tục có nhạc nền.
  const sessionA = `soak-${label}-a-${Date.now()}`;
  const stateA = await openSession(sessionA);
  const startedA = await stream(stateA, sessionA, program, 0, streamSeconds);
  await new Promise(resolve => setTimeout(resolve, 8_000));
  report.continuous = summarize(stateA, startedA, 0);

  // Pha B: giả lập tải lại trang — phát tiếp rồi đóng socket đột ngột (không SESSION_STOP) và mở phiên mới ngay.
  const sessionB = `soak-${label}-b-${Date.now()}`;
  const stateB = await openSession(sessionB);
  const startedB = await stream(stateB, sessionB, program, 0, reloadSeconds);
  stateB.closingByClient = true;
  stateB.socket.terminate();
  const sessionC = `soak-${label}-c-${Date.now()}`;
  const reopenAt = Date.now();
  const stateC = await openSession(sessionC);
  report.reload = { readyAfterReloadMs: Date.now() - reopenAt };
  const startedC = await stream(stateC, sessionC, program, 30_000, 20);
  await new Promise(resolve => setTimeout(resolve, 8_000));
  report.reload.before = summarize(stateB, startedB, 0);
  report.reload.after = summarize(stateC, startedC, 30_000);

  for (const state of [stateA, stateC]) {
    state.closingByClient = true;
    state.socket.close();
  }
  report.completedAt = new Date().toISOString();
  await mkdir(evidenceRoot, { recursive: true });
  const reportPath = path.join(evidenceRoot, `local-gateway-soak-${label}-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
