// Chạy smoke inference thật qua các worker JSONL và chỉ lưu bằng chứng trên E:.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { JsonLineWorkerClient } from '../packages/backend/dist/local/worker-client.js';
import { LocalModelManager } from '../packages/backend/dist/local/model-manager.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = path.resolve(process.env.VIETDUB_INSTALL_ROOT || 'E:\\VietDub-AI');
const modelRoot = path.join(installRoot, 'models');
const evidenceRoot = path.join(installRoot, 'evidence');
const cacheRoot = path.join(installRoot, 'cache');
const python = path.join(installRoot, 'runtime', 'venv', 'Scripts', 'python.exe');
const modelManager = new LocalModelManager(path.join(modelRoot, 'manifest.json'), modelRoot);
const modelStatus = modelManager.getStatus();
if (!modelStatus.ready) throw new Error(`Local models are not verified: ${modelStatus.errors.join('; ')}`);

if (process.platform === 'win32' && path.parse(installRoot).root.toUpperCase() !== 'E:\\') {
  throw new Error('Venv, model, cache and test evidence must stay on drive E:.');
}

const env = {
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
for (const [name, value] of Object.entries(env)) process.env[name] = value;
delete process.env.TRANSFORMERS_CACHE;
await mkdir(evidenceRoot, { recursive: true });

const clients = [];
const measurements = {};

function modelPath(component) {
  return modelManager.getModelPath(component).replaceAll('\\', '/');
}

function createClient(role) {
  const sttPath = modelPath('stt');
  const translationPath = modelPath('translation');
  const ttsPath = modelPath('tts');
  const roleArgs = role === 'stt'
    ? ['--role', 'stt', '--model-path', sttPath, '--threads', '6', '--compute-type', 'int8']
    : role === 'translation'
      ? ['--role', 'translation', '--model-path', translationPath, '--threads', '6']
      : ['--role', 'tts', '--model-path', ttsPath, '--codec-path', ttsPath + '/codec', '--threads', '6', '--voice', 'Minh Đức'];
  const client = new JsonLineWorkerClient({
    name: `VietDub ${role}`,
    command: {
      command: python,
      args: ['runtime/workers/vietdub_worker.py', ...roleArgs],
      cwd: repoRoot,
      env
    },
    startupTimeoutMs: 180_000,
    requestTimeoutMs: 180_000,
    maxQueueSize: 4,
    maxFrameBytes: 2 * 1024 * 1024
  });
  clients.push(client);
  return client;
}

async function startMeasured(client) {
  const start = performance.now();
  await client.start();
  return Math.round(performance.now() - start);
}

function parseWav(result) {
  const wav = Buffer.from(result.audioBase64, 'base64');
  const details = {
    mimeType: result.mimeType,
    sampleRate: wav.readUInt32LE(24),
    channels: wav.readUInt16LE(22),
    bitsPerSample: wav.readUInt16LE(34),
    durationMs: result.durationMs,
    bytes: wav.length
  };
  if (
    wav.toString('ascii', 0, 4) !== 'RIFF'
    || wav.toString('ascii', 8, 12) !== 'WAVE'
    || details.mimeType !== 'audio/wav'
    || details.sampleRate !== 48_000
    || details.channels !== 1
    || details.bitsPerSample !== 16
    || wav.length <= 44
  ) {
    throw new Error('TTS worker returned an invalid WAV payload.');
  }
  let squareSum = 0;
  let sampleCount = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    const sample = wav.readInt16LE(offset) / 32768;
    squareSum += sample * sample;
    sampleCount += 1;
  }
  details.rms = Math.sqrt(squareSum / Math.max(sampleCount, 1));
  if (!Number.isFinite(details.rms) || details.rms < 0.005) throw new Error('TTS WAV is silent or invalid.');
  return { wav, details };
}

function resampleWithFfmpeg(wav) {
  return new Promise((resolve, reject) => {
    // FFmpeg đổi WAV 48 kHz thành PCM mono 16 kHz ngay trong bộ nhớ.
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'wav', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => {
      if (Buffer.concat(errors).length < 4096) errors.push(chunk);
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`FFmpeg resample failed (${code}); ${Buffer.concat(errors).toString('utf8').slice(0, 300)}`));
    });
    child.stdin.end(wav);
  });
}

async function saveEvidence(name, bytes) {
  const target = path.join(evidenceRoot, name);
  await writeFile(target, bytes, { flag: 'wx' });
  return target;
}

async function main() {
  const models = modelManager.getManifest().models;
  measurements.models = Object.fromEntries(Object.entries(models).map(([key, value]) => [key, {
    modelId: value.modelId,
    revision: value.revision
  }]));

  const translation = createClient('translation');
  measurements.translationStartupMs = await startMeasured(translation);
  const translationStart = performance.now();
  const translated = await translation.request({
    op: 'translate',
    modelPath: modelPath('translation'),
    sourceText: 'The weather is beautiful today, so we are going for a walk.'
  });
  measurements.translationLatencyMs = Math.round(performance.now() - translationStart);
  measurements.translation = {
    ok: typeof translated.translatedText === 'string'
      && translated.translatedText.length > 0
      && translated.translatedText !== 'The weather is beautiful today, so we are going for a walk.',
    unicodeVietnamese: /[\u00C0-\u024F\u1EA0-\u1EFF]/u.test(translated.translatedText || ''),
    outputCharacters: translated.translatedText?.length || 0
  };
  if (!measurements.translation.ok || !measurements.translation.unicodeVietnamese) {
    throw new Error('Translation worker did not return Vietnamese text.');
  }

  const tts = createClient('tts');
  measurements.ttsStartupMs = await startMeasured(tts);
  const viStart = performance.now();
  const vietnameseAudio = await tts.request({
    op: 'synthesize',
    modelPath: modelPath('tts'),
    text: 'Xin chào. Đây là giọng thuyết minh tiếng Việt được tạo hoàn toàn trên máy.'
  });
  measurements.ttsVietnameseLatencyMs = Math.round(performance.now() - viStart);
  const vietnameseWav = parseWav(vietnameseAudio);
  measurements.ttsVietnamese = vietnameseWav.details;
  measurements.ttsVietnameseEvidence = await saveEvidence('tts-smoke-utf8.wav', vietnameseWav.wav);

  const englishStart = performance.now();
  const englishAudio = await tts.request({
    op: 'synthesize',
    modelPath: modelPath('tts'),
    text: 'Hello, this is a locally generated English speech sample for speech recognition testing.'
  });
  measurements.ttsEnglishLatencyMs = Math.round(performance.now() - englishStart);
  const englishWav = parseWav(englishAudio);
  measurements.ttsEnglish = englishWav.details;
  measurements.speechSource = 'Speech synthesized by the selected local VieNeu model; this is not a human recording.';
  const englishEvidencePath = await saveEvidence('stt-english-synthetic-source.wav', englishWav.wav);

  await translation.close();
  await tts.close();

  const pcm = await resampleWithFfmpeg(englishWav.wav);
  if (!pcm.length || pcm.length > 512 * 1024 || pcm.length % 2 !== 0) {
    throw new Error('Resampled STT input has an invalid size.');
  }
  measurements.sttInputDurationMs = pcm.length / 2 / 16_000 * 1000;
  measurements.sttInputEvidence = englishEvidencePath;

  const stt = createClient('stt');
  measurements.sttStartupMs = await startMeasured(stt);
  const zeroPcm = Buffer.alloc(16_000);
  const silenceSession = 'vietdub-smoke-silence';
  await stt.request({ op: 'start_stream', modelPath: modelPath('stt'), sessionId: silenceSession, sampleRate: 16_000, channels: 1 });
  const silentChunk = await stt.request({
    op: 'audio_chunk', modelPath: modelPath('stt'), sessionId: silenceSession,
    sampleRate: 16_000, channels: 1, pcmBase64: zeroPcm.toString('base64'), timestampMs: 0, durationMs: 500
  });
  const silentFlush = await stt.request({ op: 'end_stream', modelPath: modelPath('stt'), sessionId: silenceSession });
  measurements.sttSilenceEvents = (silentChunk.events?.length || 0) + (silentFlush.events?.length || 0);
  if (measurements.sttSilenceEvents !== 0) throw new Error('STT emitted transcript events for silence.');

  const speechSession = 'vietdub-smoke-speech';
  await stt.request({ op: 'start_stream', modelPath: modelPath('stt'), sessionId: speechSession, sampleRate: 16_000, channels: 1 });
  const sttStart = performance.now();
  const audioEvents = [];
  const chunkLimit = 256 * 1024;
  let timestampMs = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkLimit) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkLimit, pcm.length));
    const durationMs = chunk.length / 2 / 16_000 * 1000;
    const response = await stt.request({
      op: 'audio_chunk', modelPath: modelPath('stt'), sessionId: speechSession,
      sampleRate: 16_000, channels: 1, pcmBase64: chunk.toString('base64'), timestampMs, durationMs
    });
    audioEvents.push(...(response.events || []));
    timestampMs += durationMs;
  }
  const tail = await stt.request({
    op: 'audio_chunk', modelPath: modelPath('stt'), sessionId: speechSession,
    sampleRate: 16_000, channels: 1, pcmBase64: zeroPcm.toString('base64'), timestampMs, durationMs: 500
  });
  audioEvents.push(...(tail.events || []));
  const final = await stt.request({ op: 'end_stream', modelPath: modelPath('stt'), sessionId: speechSession });
  audioEvents.push(...(final.events || []));
  measurements.sttInferenceMs = Math.round(performance.now() - sttStart);
  const finalEvents = audioEvents.filter(event => event.kind === 'final' && typeof event.text === 'string' && event.text.trim());
  const transcript = finalEvents.map(event => event.text.trim()).join(' ');
  measurements.stt = {
    ok: transcript.length > 0,
    transcriptCharacters: transcript.length,
    finalEventCount: finalEvents.length,
    realTimeFactor: measurements.sttInferenceMs / Math.max(measurements.sttInputDurationMs, 1)
  };
  if (!measurements.stt.ok) throw new Error('STT produced no transcript from model-generated English speech.');

  const pipelineTranslation = await translationRequest(transcript);
  measurements.pipelineTranslation = {
    ok: typeof pipelineTranslation.translatedText === 'string'
      && pipelineTranslation.translatedText !== transcript
      && /[\u00C0-\u024F\u1EA0-\u1EFF]/u.test(pipelineTranslation.translatedText)
  };
  if (!measurements.pipelineTranslation.ok) throw new Error('Pipeline translation stage did not produce Vietnamese text.');

  const pipelineTts = createClient('tts');
  measurements.pipelineTtsStartupMs = await startMeasured(pipelineTts);
  const pipelineTtsStart = performance.now();
  const pipelineAudio = await pipelineTts.request({ op: 'synthesize', modelPath: modelPath('tts'), text: pipelineTranslation.translatedText });
  measurements.pipelineTtsLatencyMs = Math.round(performance.now() - pipelineTtsStart);
  const pipelineWav = parseWav(pipelineAudio);
  measurements.pipelineTts = { ok: true, ...pipelineWav.details };
  measurements.pipelineEvidence = await saveEvidence('local-pipeline-output.wav', pipelineWav.wav);

  await stt.close();
  await pipelineTts.close();
  measurements.localPipeline = 'PASS_WITH_SYNTHETIC_ENGLISH_SPEECH_SOURCE';
  measurements.networkInference = 'OFFLINE';
  measurements.completedAt = new Date().toISOString();
  const reportPath = path.join(evidenceRoot, 'local-pipeline-smoke.json');
  await writeFile(reportPath, `${JSON.stringify(measurements, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...measurements, reportPath }));
}

async function translationRequest(sourceText) {
  const client = createClient('translation');
  await client.start();
  try {
    return await client.request({ op: 'translate', modelPath: modelPath('translation'), sourceText });
  } finally {
    await client.close();
  }
}

try {
  await main();
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
}
