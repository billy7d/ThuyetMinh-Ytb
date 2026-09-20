import path from 'node:path';
import { DeepgramStreamingSTTProvider } from './stt/deepgram-stt.js';
import { STTProvider } from './stt/types.js';
import { GeminiTranslationProvider } from './translation/gemini-translation.js';
import { TranslationEngine } from './translation/translation-engine.js';
import { GoogleCloudTTSProvider } from './tts/google-cloud-tts.js';
import { TTSProvider } from './tts/types.js';
import { BudgetConfig } from './cost/cost-tracker.js';
import { LocalModelManager, LocalModelStatus } from './local/model-manager.js';
import { createLocalProviders, createLocalRuntime, LocalRuntime } from './local/runtime.js';
import { LocalWorkerStatus } from './local/worker-client.js';

export type RuntimeMode = 'local' | 'cloud';

export interface ProductionPipelineDependencies {
  sttProvider: STTProvider;
  translationEngine: TranslationEngine;
  ttsProvider: TTSProvider;
  budgetConfig: Partial<BudgetConfig>;
}

export interface ProviderFactoryStatus {
  mode: RuntimeMode;
  configured: boolean;
  missingConfiguration: string[];
  localModels?: LocalModelStatus;
  localWorkers?: {
    stt?: LocalWorkerStatus;
    translation?: LocalWorkerStatus;
    tts?: LocalWorkerStatus;
  };
}

export interface ProductionProviderFactory {
  readonly mode: RuntimeMode;
  readonly missingConfiguration: string[];
  create(): ProductionPipelineDependencies;
  getStatus(): ProviderFactoryStatus;
  warmup?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Creates the production runtime boundary. Local inference is the default and
 * is the only mode that can be selected without an explicit cloud opt-in.
 * Cloud adapters remain available for separately authorized diagnostics, but
 * they are never a fallback when local inference is unavailable.
 */
export function createProductionProviderFactory(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): ProductionProviderFactory {
  const mode = parseRuntimeMode(env.AI_MODE);
  if (mode === 'local') return createLocalFactory(env, cwd);
  if (mode === 'cloud') return createExplicitCloudFactory(env);
  return createInvalidFactory(env.AI_MODE);
}

function createLocalFactory(env: NodeJS.ProcessEnv, cwd: string): ProductionProviderFactory {
  const manifestPath = resolvePath(env.LOCAL_MODEL_MANIFEST || 'models/manifest.json', cwd);
  const modelRoot = resolvePath(env.LOCAL_MODEL_ROOT || path.dirname(manifestPath), cwd);
  const modelManager = new LocalModelManager(manifestPath, modelRoot);
  const runtimeMissing = localRuntimeMissingConfiguration(env);
  let runtime: LocalRuntime | null = null;
  let dependencies: ProductionPipelineDependencies | null = null;

  const getMissing = (): string[] => [...new Set([...modelManager.getMissingConfiguration(), ...runtimeMissing])];
  const factory: ProductionProviderFactory = {
    mode: 'local',
    get missingConfiguration(): string[] {
      return getMissing();
    },
    create(): ProductionPipelineDependencies {
      const missing = getMissing();
      if (missing.length > 0) {
        throw new Error(`Local AI is not ready: ${missing.join(', ')}`);
      }
      if (dependencies) return dependencies;

      runtime ||= createLocalRuntime(env, { cwd });
      const providers = createLocalProviders(runtime, env);
      dependencies = {
        sttProvider: providers.sttProvider,
        translationEngine: new TranslationEngine(providers.translationProvider, undefined, {
          maxPendingCharacters: positiveInt(env.LOCAL_TRANSLATION_MAX_PENDING_CHARACTERS, 1200),
          maxTranslationCharacters: positiveInt(env.LOCAL_TRANSLATION_MAX_TRANSLATION_CHARACTERS, 2400),
          maxContextItems: positiveInt(env.LOCAL_TRANSLATION_MAX_CONTEXT_ITEMS, 5),
          validateVietnamese: true
        }),
        ttsProvider: providers.ttsProvider,
        budgetConfig: {
          costMode: 'local',
          maxCostPerSessionUsd: 0,
          maxSessionMinutes: positiveInt(env.MAX_SESSION_MINUTES, 30),
          rateLimitChunksPerSecond: positiveInt(env.MAX_AUDIO_CHUNKS_PER_SECOND, 10)
        }
      };
      return dependencies;
    },
    async warmup(): Promise<void> {
      const missing = getMissing();
      if (missing.length > 0) throw new Error(`Local AI is not ready: ${missing.join(', ')}`);
      runtime ||= createLocalRuntime(env, { cwd });
      await runtime.warmup();
    },
    getStatus(): ProviderFactoryStatus {
      const workerStatus = runtime?.getWorkerStatus();
      const workerMissing = workerStatus
        ? Object.entries(workerStatus)
          .filter(([, status]) => status && status.state !== 'ready')
          .map(([component, status]) => `LOCAL_${component.toUpperCase()}_WORKER_READY${status?.error ? ` (${status.error})` : ''}`)
        : [];
      const missing = [...new Set([...getMissing(), ...workerMissing])];
      return {
        mode: 'local',
        configured: missing.length === 0,
        missingConfiguration: missing,
        localModels: modelManager.getStatus(),
        localWorkers: workerStatus
      };
    },
    async close(): Promise<void> {
      dependencies = null;
      const activeRuntime = runtime;
      runtime = null;
      await activeRuntime?.close();
    }
  };
  return factory;
}

function createExplicitCloudFactory(env: NodeJS.ProcessEnv): ProductionProviderFactory {
  const missingConfiguration: string[] = [];
  if (!isTrue(env.CLOUD_PROVIDERS_ENABLED)) missingConfiguration.push('CLOUD_PROVIDERS_ENABLED=true');
  if (!isTrue(env.PAID_API_ALLOWED)) missingConfiguration.push('PAID_API_ALLOWED=true');

  const deepgramApiKey = env.DEEPGRAM_API_KEY?.trim();
  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  const geminiModel = env.GEMINI_MODEL?.trim();
  const googleTtsApiKey = env.GOOGLE_CLOUD_TTS_API_KEY?.trim();
  const googleTtsAccessToken = env.GOOGLE_CLOUD_TTS_ACCESS_TOKEN?.trim();

  if (!deepgramApiKey) missingConfiguration.push('DEEPGRAM_API_KEY');
  if (!geminiApiKey) missingConfiguration.push('GEMINI_API_KEY');
  if (!geminiModel) missingConfiguration.push('GEMINI_MODEL');
  if (!googleTtsApiKey && !googleTtsAccessToken) {
    missingConfiguration.push('GOOGLE_CLOUD_TTS_API_KEY or GOOGLE_CLOUD_TTS_ACCESS_TOKEN');
  }

  let dependencies: ProductionPipelineDependencies | null = null;
  const factory: ProductionProviderFactory = {
    mode: 'cloud',
    get missingConfiguration(): string[] {
      return [...missingConfiguration];
    },
    create(): ProductionPipelineDependencies {
      if (missingConfiguration.length > 0) {
        throw new Error(`Explicit cloud providers are not configured: ${missingConfiguration.join(', ')}`);
      }
      if (dependencies) return dependencies;

      const sttProvider = new DeepgramStreamingSTTProvider({
        apiKey: deepgramApiKey!,
        model: env.DEEPGRAM_MODEL || 'nova-3',
        language: env.DEEPGRAM_LANGUAGE || 'en-US',
        sampleRate: positiveInt(env.DEEPGRAM_SAMPLE_RATE, 16_000),
        channels: positiveInt(env.DEEPGRAM_CHANNELS, 1),
        endpointingMs: positiveInt(env.DEEPGRAM_ENDPOINTING_MS, 450),
        utteranceEndMs: positiveInt(env.DEEPGRAM_UTTERANCE_END_MS, 1000),
        connectionTimeoutMs: positiveInt(env.DEEPGRAM_CONNECTION_TIMEOUT_MS, 8000),
        maxBufferedAudioBytes: positiveInt(env.DEEPGRAM_MAX_BUFFERED_AUDIO_BYTES, 2 * 1024 * 1024),
        maxReconnectAttempts: Number(env.DEEPGRAM_MAX_RECONNECT_ATTEMPTS || 2)
      });
      const translationEngine = new TranslationEngine(new GeminiTranslationProvider({
        apiKey: geminiApiKey!,
        model: geminiModel!,
        timeoutMs: positiveInt(env.GEMINI_TIMEOUT_MS, 12_000),
        maxOutputTokens: positiveInt(env.GEMINI_MAX_OUTPUT_TOKENS, 512)
      }));
      const ttsProvider = new GoogleCloudTTSProvider({
        apiKey: googleTtsApiKey || undefined,
        accessToken: googleTtsAccessToken || undefined,
        languageCode: env.GOOGLE_CLOUD_TTS_LANGUAGE || 'vi-VN',
        voiceName: env.GOOGLE_CLOUD_TTS_VOICE || 'vi-VN-Standard-A',
        sampleRateHertz: positiveInt(env.GOOGLE_CLOUD_TTS_SAMPLE_RATE, 24_000),
        timeoutMs: positiveInt(env.GOOGLE_CLOUD_TTS_TIMEOUT_MS, 15_000)
      });
      dependencies = {
        sttProvider,
        translationEngine,
        ttsProvider,
        budgetConfig: {
          costMode: 'cloud',
          maxCostPerSessionUsd: positiveNumber(env.MAX_COST_PER_SESSION_USD, 2),
          maxSessionMinutes: positiveInt(env.MAX_SESSION_MINUTES, 30),
          rateLimitChunksPerSecond: positiveInt(env.MAX_AUDIO_CHUNKS_PER_SECOND, 10)
        }
      };
      return dependencies;
    },
    getStatus(): ProviderFactoryStatus {
      return {
        mode: 'cloud',
        configured: missingConfiguration.length === 0,
        missingConfiguration: [...missingConfiguration]
      };
    }
  };
  return factory;
}

function createInvalidFactory(rawMode: string | undefined): ProductionProviderFactory {
  const mode = 'local' as const;
  const missingConfiguration = [`AI_MODE must be local or cloud (received ${rawMode || 'empty'})`];
  return {
    mode,
    missingConfiguration,
    create(): ProductionPipelineDependencies {
      throw new Error(`Invalid runtime configuration: ${missingConfiguration.join(', ')}`);
    },
    getStatus(): ProviderFactoryStatus {
      return { mode, configured: false, missingConfiguration: [...missingConfiguration] };
    },
    async warmup(): Promise<void> {
      throw new Error(`Invalid runtime configuration: ${missingConfiguration.join(', ')}`);
    }
  };
}

function localRuntimeMissingConfiguration(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  for (const component of ['STT', 'TRANSLATION', 'TTS']) {
    if (!env[`LOCAL_${component}_WORKER_COMMAND`]?.trim()) {
      missing.push(`LOCAL_${component}_WORKER_COMMAND`);
    }
  }
  return missing;
}

function parseRuntimeMode(value: string | undefined): RuntimeMode | null {
  const normalized = (value || 'local').trim().toLowerCase();
  return normalized === 'local' || normalized === 'cloud' ? normalized : null;
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePath(value: string, cwd: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}
