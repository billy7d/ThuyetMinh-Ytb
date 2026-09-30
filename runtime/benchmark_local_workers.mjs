// Đo worker local thật, chỉ lưu số liệu tổng hợp và không ghi transcript.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { JsonLineWorkerClient } from '../packages/backend/dist/local/worker-client.js';
import { LocalModelManager } from '../packages/backend/dist/local/model-manager.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = path.resolve(process.env.VIETDUB_INSTALL_ROOT || 'E:\\VietDub-AI');
const cacheRoot = path.join(installRoot, 'cache');
const evidenceRoot = path.join(installRoot, 'evidence');
const python = path.join(installRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
const ffmpeg = 'D:\\ffmpeg-essentials_build\\ffmpeg-2026-06-15-git-44d082edc8-essentials_build\\bin\\ffmpeg.exe';
const modelManager = new LocalModelManager(path.join(installRoot, 'models', 'manifest.json'), path.join(installRoot, 'models'));
const status = modelManager.getStatus();
if (!status.ready) throw new Error(`Model local chưa được xác minh: ${status.errors.join('; ')}`);
if (process.platform === 'win32' && path.parse(installRoot).root.toUpperCase() !== 'E:\\') {
  throw new Error('Model, cache, venv và bằng chứng benchmark phải nằm trên ổ E:.');
}

const workerEnv = {
  HF_HOME: path.join(cacheRoot, 'huggingface'),
  HUGGINGFACE_HUB_CACHE: path.join(cacheRoot, 'huggingface', 'hub'),
  TORCH_HOME: path.join(cacheRoot, 'torch'),
  XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
  PYTHONPYCACHEPREFIX: path.join(cacheRoot, 'pycache'),
  TEMP: path.join(cacheRoot, 'temp'),
  TMP: path.join(cacheRoot, 'temp'),
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  OMP_NUM_THREADS: '6',
  MKL_NUM_THREADS: '6'
};
for (const [name, value] of Object.entries(workerEnv)) process.env[name] = value;

const clients = [];
const englishSamples = [
  'The speaker explains how plants turn sunlight into energy.',
  'A family walks along the beach while the weather is calm.',
  'The new bridge connects the village with the nearby city.'
];
const translationSamples = [
  'The weather is beautiful today, so we are going for a walk.',
  'The speaker explains how plants turn sunlight into energy.',
  'A family walks along the beach while the weather is calm.',
  'The new bridge connects the village with the nearby city.',
  'Please remember to save your work before closing the program.',
  'The train leaves the station every morning at seven o’clock.',
  'Fresh vegetables are an important part of a healthy meal.',
  'The children are learning how to protect the environment.',
  'We will meet again after the presentation has finished.',
  'This small library is open to everyone in the neighborhood.',
  'The mountain path becomes slippery after heavy rain.',
  'She carefully checked the map before choosing a direction.',
  'The museum displays objects from several different periods.',
  'Good communication helps a team solve problems together.',
  'The farmer grows rice in the fields beside the river.',
  'A quiet room can make it easier to focus on reading.',
  'The engineer tested the device under several conditions.',
  'Local markets are busiest early in the morning.',
  'The film tells a story about friendship and courage.',
  'Please speak clearly so that everyone can understand.',
  'The old house has a garden filled with colorful flowers.',
  'We should check the traffic before starting the journey.',
  'The community center offers free classes every weekend.',
  'A balanced schedule includes time for rest and exercise.',
  'The boat moved slowly across the lake at sunset.',
  'She wrote down the address to avoid forgetting it.',
  'The workshop teaches practical skills for daily life.',
  'Clouds covered the sky, but the rain soon stopped.',
  'The guide described the history of the ancient temple.',
  'Thank you for listening to this short explanation.'
];
const vietnameseSamples = [
  'Xin chào, chào mừng bạn đến với chương trình hôm nay.',
  'Chúng ta sẽ cùng tìm hiểu câu chuyện thú vị này.',
  'Thời tiết hôm nay khá đẹp và dễ chịu.',
  'Cây xanh cần ánh sáng mặt trời để phát triển.',
  'Gia đình đang đi dạo bên bờ biển yên bình.',
  'Cây cầu mới nối ngôi làng với thành phố gần đó.',
  'Hãy lưu lại công việc trước khi đóng chương trình.',
  'Chuyến tàu rời ga vào lúc bảy giờ mỗi sáng.',
  'Rau củ tươi là một phần quan trọng của bữa ăn.',
  'Các em nhỏ đang học cách bảo vệ môi trường.',
  'Chúng ta sẽ gặp lại sau khi phần trình bày kết thúc.',
  'Thư viện nhỏ này mở cửa cho mọi người trong khu phố.',
  'Con đường lên núi có thể trơn trượt sau cơn mưa lớn.',
  'Cô ấy kiểm tra bản đồ cẩn thận trước khi chọn hướng đi.',
  'Bảo tàng trưng bày hiện vật từ nhiều thời kỳ khác nhau.',
  'Giao tiếp tốt giúp cả nhóm cùng giải quyết vấn đề.',
  'Người nông dân trồng lúa trên cánh đồng cạnh dòng sông.',
  'Khu chợ địa phương đông vui nhất vào buổi sáng sớm.',
  'Bộ phim kể về tình bạn và lòng can đảm.',
  'Xin hãy nói rõ ràng để mọi người đều có thể hiểu.'
];

function modelPath(component) {
  return modelManager.getModelPath(component).replaceAll('\\', '/');
}

function createClient(role) {
  const sttPath = modelPath('stt');
  const translationPath = modelPath('translation');
  const ttsPath = modelPath('tts');
  const args = role === 'stt'
    ? ['--role', 'stt', '--model-path', sttPath, '--threads', '6', '--compute-type', 'int8']
    : role === 'translation'
      ? ['--role', 'translation', '--model-path', translationPath, '--threads', '6']
      : ['--role', 'tts', '--model-path', ttsPath, '--codec-path', `${ttsPath}/codec`, '--threads', '6', '--voice', 'Minh Đức'];
  const client = new JsonLineWorkerClient({
    name: `VietDub benchmark ${role}`,
    command: { command: python, args: ['runtime/workers/vietdub_worker.py', ...args], cwd: repositoryRoot, env: workerEnv },
    startupTimeoutMs: 180_000,
    requestTimeoutMs: 180_000,
    maxQueueSize: 4,
    maxFrameBytes: 2 * 1024 * 1024
  });
  clients.push(client);
  return client;
}

async function measuredStart(client) {
  const started = performance.now();
  await client.start();
  return Math.round(performance.now() - started);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function wavDetails(result) {
  const wav = Buffer.from(result.audioBase64, 'base64');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('TTS trả về dữ liệu không phải RIFF/WAVE.');
  }
  const details = {
    sampleRate: wav.readUInt32LE(24),
    channels: wav.readUInt16LE(22),
    bitsPerSample: wav.readUInt16LE(34),
    durationMs: result.durationMs,
    bytes: wav.length
  };
  if (details.sampleRate !== 48_000 || details.channels !== 1 || details.bitsPerSample !== 16 || wav.length <= 44) {
    throw new Error('Metadata TTS WAV không đúng 48 kHz, mono, PCM16.');
  }
  let squareSum = 0;
  let samples = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    const value = wav.readInt16LE(offset) / 32768;
    squareSum += value * value;
    samples += 1;
  }
  details.rms = Math.sqrt(squareSum / Math.max(samples, 1));
  if (!Number.isFinite(details.rms) || details.rms < 0.005) throw new Error('TTS WAV bị im lặng.');
  return { wav, details };
}

function toPcm16k(wav) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'wav', '-i', 'pipe:0',
      '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Không chuyển được audio STT về PCM 16 kHz (exit ${code}).`));
    });
    child.stdin.end(wav);
  });
}

function pythonProcessSnapshot(excludedPids = []) {
  const excludedList = excludedPids.length ? excludedPids.join(',') : '0';
  const command = `$excluded=@(${excludedList}); @(Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'E:\\*' -and $excluded -notcontains $_.Id } | Select-Object Id,CPU,WorkingSet64,Path) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
      pid: item.Id,
      cpuSeconds: Number(item.CPU) || 0,
      workingSetBytes: Number(item.WorkingSet64) || 0,
      path: String(item.Path || '')
    }));
  } catch {
    return [];
  }
}

async function main() {
  await mkdir(evidenceRoot, { recursive: true });
  const pythonPidsBefore = pythonProcessSnapshot().map(process => process.pid);
  const report = {
    startedAt: new Date().toISOString(),
    sourceAudio: 'Ba câu tiếng Anh được tổng hợp bằng VieNeu cục bộ; không phải giọng người thật.',
    inferenceNetwork: 'offline',
    modelRevisions: Object.fromEntries(Object.entries(modelManager.getManifest().models).map(([key, value]) => [key, value.revision])),
    host: { logicalCpuCount: os.cpus().length, totalRamBytes: os.totalmem(), freeRamBeforeBytes: os.freemem() },
    sampleCounts: { translation: translationSamples.length, tts: vietnameseSamples.length, stt: englishSamples.length }
  };

  const translation = createClient('translation');
  const tts = createClient('tts');
  const stt = createClient('stt');
  report.workerStartupMs = {
    translation: await measuredStart(translation),
    tts: await measuredStart(tts),
    stt: await measuredStart(stt)
  };
  const processesBefore = pythonProcessSnapshot(pythonPidsBefore);
  report.workersBefore = processesBefore;

  const translationLatencies = [];
  let validTranslations = 0;
  for (const sourceText of translationSamples) {
    const started = performance.now();
    const result = await translation.request({ op: 'translate', modelPath: modelPath('translation'), sourceText });
    translationLatencies.push(Math.round(performance.now() - started));
    if (typeof result.translatedText === 'string' && result.translatedText.length > 0 &&
      result.translatedText !== sourceText && /[\u00C0-\u024F\u1EA0-\u1EFF]/u.test(result.translatedText)) {
      validTranslations += 1;
    }
  }
  report.translation = {
    valid: validTranslations === translationSamples.length,
    validCount: validTranslations,
    count: translationLatencies.length,
    latencyP50Ms: percentile(translationLatencies, 0.50),
    latencyP95Ms: percentile(translationLatencies, 0.95),
    latencyMaxMs: Math.max(...translationLatencies)
  };
  if (!report.translation.valid) throw new Error(`Chỉ ${validTranslations}/${translationSamples.length} câu dịch hợp lệ.`);

  const ttsLatencies = [];
  const ttsDurations = [];
  for (const text of vietnameseSamples) {
    const started = performance.now();
    const result = await tts.request({ op: 'synthesize', modelPath: modelPath('tts'), text });
    ttsLatencies.push(Math.round(performance.now() - started));
    ttsDurations.push(wavDetails(result).details.durationMs);
  }
  report.tts = {
    valid: ttsLatencies.length === vietnameseSamples.length,
    count: ttsLatencies.length,
    latencyP50Ms: percentile(ttsLatencies, 0.50),
    latencyP95Ms: percentile(ttsLatencies, 0.95),
    latencyMaxMs: Math.max(...ttsLatencies),
    outputDurationP50Ms: percentile(ttsDurations, 0.50)
  };

  const sttSamples = [];
  for (let index = 0; index < englishSamples.length; index += 1) {
    const audio = await tts.request({ op: 'synthesize', modelPath: modelPath('tts'), text: englishSamples[index] });
    const wav = wavDetails(audio).wav;
    const pcm = await toPcm16k(wav);
    const sessionId = `vietdub-benchmark-${Date.now()}-${index}`;
    await stt.request({ op: 'start_stream', modelPath: modelPath('stt'), sessionId, sampleRate: 16_000, channels: 1 });
    const inferenceStarted = performance.now();
    const events = [];
    let timestampMs = 0;
    const chunkBytes = 128 * 1024;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
      const durationMs = chunk.length / 2 / 16_000 * 1000;
      const result = await stt.request({
        op: 'audio_chunk', modelPath: modelPath('stt'), sessionId, sampleRate: 16_000, channels: 1,
        pcmBase64: chunk.toString('base64'), timestampMs, durationMs
      });
      events.push(...(result.events || []));
      timestampMs += durationMs;
    }
    const silence = Buffer.alloc(16_000);
    const tail = await stt.request({
      op: 'audio_chunk', modelPath: modelPath('stt'), sessionId, sampleRate: 16_000, channels: 1,
      pcmBase64: silence.toString('base64'), timestampMs, durationMs: 500
    });
    events.push(...(tail.events || []));
    const final = await stt.request({ op: 'end_stream', modelPath: modelPath('stt'), sessionId });
    events.push(...(final.events || []));
    const inferenceMs = Math.round(performance.now() - inferenceStarted);
    const finalEvents = events.filter(event => event.kind === 'final' && typeof event.text === 'string' && event.text.trim());
    const audioDurationMs = pcm.length / 2 / 16_000 * 1000;
    sttSamples.push({
      valid: finalEvents.length > 0,
      durationMs: Math.round(audioDurationMs),
      inferenceMs,
      realTimeFactor: Number((inferenceMs / Math.max(audioDurationMs, 1)).toFixed(4)),
      transcriptCharacters: finalEvents.reduce((sum, event) => sum + event.text.trim().length, 0)
    });
  }
  report.stt = {
    valid: sttSamples.length === englishSamples.length && sttSamples.every(sample => sample.valid),
    count: sttSamples.length,
    samples: sttSamples,
    rtfP50: percentile(sttSamples.map(sample => sample.realTimeFactor), 0.50),
    rtfP95: percentile(sttSamples.map(sample => sample.realTimeFactor), 0.95)
  };
  if (!report.tts.valid || !report.stt.valid) throw new Error('TTS hoặc STT benchmark có mẫu không hợp lệ.');

  report.workersAfter = pythonProcessSnapshot(pythonPidsBefore);
  report.host.freeRamAfterBytes = os.freemem();
  report.nodeRssBytes = process.memoryUsage.rss();
  report.memoryGrowthBytes = report.workersAfter.reduce((sum, item) => sum + item.workingSetBytes, 0) -
    report.workersBefore.reduce((sum, item) => sum + item.workingSetBytes, 0);
  report.workerCpuSeconds = Number((report.workersAfter.reduce((sum, item) => sum + item.cpuSeconds, 0) -
    report.workersBefore.reduce((sum, item) => sum + item.cpuSeconds, 0)).toFixed(3));
  report.completedAt = new Date().toISOString();
  const reportPath = path.join(evidenceRoot, `local-worker-benchmark-${Date.now()}.json`);
  console.log(JSON.stringify({ ...report, reportPath }));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}

try {
  await main();
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
}
