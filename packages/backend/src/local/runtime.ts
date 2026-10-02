import path from 'node:path';
import { LocalModelManager } from './model-manager.js';
import { JsonLineWorkerClient, LocalWorkerClientLike, LocalWorkerStatus } from './worker-client.js';
import { LocalStreamingSTTProvider } from './local-stt.js';
import { LocalTranslationProvider } from './local-translation.js';
import { LocalVietnameseTTSProvider } from './local-tts.js';

const MIN_TTS_FRAME_BYTES = 8 * 1024 * 1024;

export interface LocalRuntimeOptions {
  cwd?: string;
}

export interface LocalRuntime {
  modelManager: LocalModelManager;
  sttWorker: LocalWorkerClientLike;
  translationWorker: LocalWorkerClientLike;
  ttsWorker: LocalWorkerClientLike;
  warmup(): Promise<void>;
  getWorkerStatus(): { stt: LocalWorkerStatus | undefined; translation: LocalWorkerStatus | undefined; tts: LocalWorkerStatus | undefined };
  close(): Promise<void>;
}

export function createLocalRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: LocalRuntimeOptions = {}
): LocalRuntime {
  const cwd = options.cwd || process.cwd();
  const manifestPath = resolveFromCwd(env.LOCAL_MODEL_MANIFEST || 'models/manifest.json', cwd);
  const modelRoot = resolveFromCwd(env.LOCAL_MODEL_ROOT || path.dirname(manifestPath), cwd);
  const modelManager = new LocalModelManager(manifestPath, modelRoot);

  const workerOptions = {
    startupTimeoutMs: positiveInt(env.LOCAL_WORKER_STARTUP_TIMEOUT_MS, 90_000),
    requestTimeoutMs: positiveInt(env.LOCAL_WORKER_REQUEST_TIMEOUT_MS, 90_000),
    maxQueueSize: positiveInt(env.LOCAL_WORKER_MAX_QUEUE, 32),
    maxFrameBytes: positiveInt(env.LOCAL_WORKER_MAX_FRAME_BYTES, 2 * 1024 * 1024),
    // Log stderr của worker nằm cạnh thư mục model (ngoài Git) để chẩn đoán lỗi suy luận.
    logDir: resolveFromCwd(env.LOCAL_WORKER_LOG_DIR || path.join(path.dirname(modelRoot), 'logs'), cwd)
  };

  const sttWorker = createWorker('stt', env, workerOptions, cwd);
  const translationWorker = createWorker('translation', env, workerOptions, cwd);
  const ttsWorker = createWorker('tts', env, workerOptions, cwd);

  return {
    modelManager,
    sttWorker,
    translationWorker,
    ttsWorker,
    async warmup(): Promise<void> {
      await Promise.all([
        sttWorker.start?.(),
        translationWorker.start?.(),
        ttsWorker.start?.()
      ]);
    },
    getWorkerStatus() {
      return {
        stt: getStatus(sttWorker),
        translation: getStatus(translationWorker),
        tts: getStatus(ttsWorker)
      };
    },
    async close(): Promise<void> {
      await Promise.all([sttWorker.close(), translationWorker.close(), ttsWorker.close()]);
    }
  };
}

function getStatus(worker: LocalWorkerClientLike): LocalWorkerStatus | undefined {
  return 'getStatus' in worker && typeof worker.getStatus === 'function' ? worker.getStatus() : undefined;
}

export function createLocalProviders(
  runtime: LocalRuntime,
  env: NodeJS.ProcessEnv = process.env
): {
  sttProvider: LocalStreamingSTTProvider;
  translationProvider: LocalTranslationProvider;
  ttsProvider: LocalVietnameseTTSProvider;
} {
  const modelManager = runtime.modelManager;
  return {
    sttProvider: new LocalStreamingSTTProvider(runtime.sttWorker, {
      modelPath: modelManager.getModelPath('stt'),
      sampleRate: positiveInt(env.LOCAL_STT_SAMPLE_RATE, 16_000),
      channels: positiveInt(env.LOCAL_STT_CHANNELS, 1),
      maxBufferedMs: positiveInt(env.LOCAL_STT_MAX_BUFFERED_MS, 8_000),
      maxRequestMs: positiveInt(env.LOCAL_STT_MAX_REQUEST_MS, 4_000)
    }),
    translationProvider: new LocalTranslationProvider(runtime.translationWorker, {
      modelPath: modelManager.getModelPath('translation'),
      timeoutMs: positiveInt(env.LOCAL_TRANSLATION_TIMEOUT_MS, 20_000)
    }),
    ttsProvider: new LocalVietnameseTTSProvider(runtime.ttsWorker, {
      modelPath: modelManager.getModelPath('tts'),
      timeoutMs: positiveInt(env.LOCAL_TTS_TIMEOUT_MS, 90_000),
      maxConcurrentRequests: positiveInt(env.LOCAL_TTS_MAX_CONCURRENT_REQUESTS, 2),
      sampleRate: positiveInt(env.LOCAL_TTS_SAMPLE_RATE, 48_000)
    })
  };
}

function createWorker(
  component: 'stt' | 'translation' | 'tts',
  env: NodeJS.ProcessEnv,
  limits: {
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    maxQueueSize: number;
    maxFrameBytes: number;
    logDir: string;
  },
  cwd: string
): LocalWorkerClientLike {
  const prefix = `LOCAL_${component.toUpperCase()}_WORKER`;
  const command = env[`${prefix}_COMMAND`]?.trim();
  if (!command) throw new Error(`${prefix}_COMMAND is required`);
  const args = parseArgs(env[`${prefix}_ARGS`], prefix);
  const { logDir, ...workerLimits } = limits;
  return new JsonLineWorkerClient({
    name: `Local ${component.toUpperCase()}`,
    // Chuẩn hóa working directory để đường dẫn tương đối tính từ root repository.
    command: { command, args, cwd },
    stderrLogPath: path.join(logDir, `worker-${component}.log`),
    ...workerLimits,
    // WAV 48 kHz của TTS lớn hơn nhiều so với JSON của STT/dịch: 2 MB chỉ chứa ~15 s audio và vượt quá sẽ làm worker bị đóng.
    maxFrameBytes: component === 'tts' ? Math.max(workerLimits.maxFrameBytes, MIN_TTS_FRAME_BYTES) : workerLimits.maxFrameBytes
  });
}

function parseArgs(raw: string | undefined, field: string): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
      throw new Error('must be a JSON array of strings');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${field}_ARGS ${error instanceof Error ? error.message : String(error)}`);
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveFromCwd(value: string, cwd: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}
