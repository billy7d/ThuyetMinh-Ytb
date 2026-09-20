import path from 'node:path';
import { LocalModelManager } from './model-manager.js';
import { JsonLineWorkerClient, LocalWorkerClientLike, LocalWorkerStatus } from './worker-client.js';
import { LocalStreamingSTTProvider } from './local-stt.js';
import { LocalTranslationProvider } from './local-translation.js';
import { LocalVietnameseTTSProvider } from './local-tts.js';

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
    startupTimeoutMs: positiveInt(env.LOCAL_WORKER_STARTUP_TIMEOUT_MS, 15_000),
    requestTimeoutMs: positiveInt(env.LOCAL_WORKER_REQUEST_TIMEOUT_MS, 30_000),
    maxQueueSize: positiveInt(env.LOCAL_WORKER_MAX_QUEUE, 32),
    maxFrameBytes: positiveInt(env.LOCAL_WORKER_MAX_FRAME_BYTES, 2 * 1024 * 1024)
  };

  const sttWorker = createWorker('stt', env, workerOptions);
  const translationWorker = createWorker('translation', env, workerOptions);
  const ttsWorker = createWorker('tts', env, workerOptions);

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
      maxPendingChunks: positiveInt(env.LOCAL_STT_MAX_PENDING_CHUNKS, 12)
    }),
    translationProvider: new LocalTranslationProvider(runtime.translationWorker, {
      modelPath: modelManager.getModelPath('translation'),
      timeoutMs: positiveInt(env.LOCAL_TRANSLATION_TIMEOUT_MS, 20_000)
    }),
    ttsProvider: new LocalVietnameseTTSProvider(runtime.ttsWorker, {
      modelPath: modelManager.getModelPath('tts'),
      timeoutMs: positiveInt(env.LOCAL_TTS_TIMEOUT_MS, 30_000),
      maxConcurrentRequests: positiveInt(env.LOCAL_TTS_MAX_CONCURRENT_REQUESTS, 2),
      sampleRate: positiveInt(env.LOCAL_TTS_SAMPLE_RATE, 24_000)
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
  }
): LocalWorkerClientLike {
  const prefix = `LOCAL_${component.toUpperCase()}_WORKER`;
  const command = env[`${prefix}_COMMAND`]?.trim();
  if (!command) throw new Error(`${prefix}_COMMAND is required`);
  const args = parseArgs(env[`${prefix}_ARGS`], prefix);
  return new JsonLineWorkerClient({
    name: `Local ${component.toUpperCase()}`,
    command: { command, args },
    ...limits
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
