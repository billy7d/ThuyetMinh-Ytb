import { DeepgramStreamingSTTProvider } from './stt/deepgram-stt.js';
import { STTProvider } from './stt/types.js';
import { GeminiTranslationProvider } from './translation/gemini-translation.js';
import { TranslationEngine } from './translation/translation-engine.js';
import { GoogleCloudTTSProvider } from './tts/google-cloud-tts.js';
import { TTSProvider } from './tts/types.js';
import { BudgetConfig } from './cost/cost-tracker.js';

export interface ProductionPipelineDependencies {
  sttProvider: STTProvider;
  translationEngine: TranslationEngine;
  ttsProvider: TTSProvider;
  budgetConfig: Partial<BudgetConfig>;
}

export interface ProductionProviderFactory {
  readonly missingConfiguration: string[];
  create(): ProductionPipelineDependencies;
}

export function createProductionProviderFactory(
  env: NodeJS.ProcessEnv = process.env
): ProductionProviderFactory {
  const missingConfiguration: string[] = [];
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

  return {
    missingConfiguration,
    create(): ProductionPipelineDependencies {
      if (missingConfiguration.length > 0) {
        throw new Error(`Production providers are not configured: ${missingConfiguration.join(', ')}`);
      }

      const sttProvider = new DeepgramStreamingSTTProvider({
        apiKey: deepgramApiKey!,
        model: env.DEEPGRAM_MODEL || 'nova-3',
        language: env.DEEPGRAM_LANGUAGE || 'en-US',
        sampleRate: Number(env.DEEPGRAM_SAMPLE_RATE || 16000),
        channels: Number(env.DEEPGRAM_CHANNELS || 1),
        endpointingMs: Number(env.DEEPGRAM_ENDPOINTING_MS || 450),
        utteranceEndMs: Number(env.DEEPGRAM_UTTERANCE_END_MS || 1000),
        connectionTimeoutMs: Number(env.DEEPGRAM_CONNECTION_TIMEOUT_MS || 8000),
        maxBufferedAudioBytes: Number(env.DEEPGRAM_MAX_BUFFERED_AUDIO_BYTES || 2 * 1024 * 1024),
        maxReconnectAttempts: Number(env.DEEPGRAM_MAX_RECONNECT_ATTEMPTS || 2)
      });
      const translationEngine = new TranslationEngine(new GeminiTranslationProvider({
        apiKey: geminiApiKey!,
        model: geminiModel!,
        timeoutMs: Number(env.GEMINI_TIMEOUT_MS || 12000),
        maxOutputTokens: Number(env.GEMINI_MAX_OUTPUT_TOKENS || 512)
      }));
      const ttsProvider = new GoogleCloudTTSProvider({
        apiKey: googleTtsApiKey || undefined,
        accessToken: googleTtsAccessToken || undefined,
        languageCode: env.GOOGLE_CLOUD_TTS_LANGUAGE || 'vi-VN',
        voiceName: env.GOOGLE_CLOUD_TTS_VOICE || 'vi-VN-Standard-A',
        sampleRateHertz: Number(env.GOOGLE_CLOUD_TTS_SAMPLE_RATE || 24000),
        timeoutMs: Number(env.GOOGLE_CLOUD_TTS_TIMEOUT_MS || 15000)
      });

      return {
        sttProvider,
        translationEngine,
        ttsProvider,
        budgetConfig: {
          maxCostPerSessionUsd: Number(env.MAX_COST_PER_SESSION_USD || 2),
          maxSessionMinutes: Number(env.MAX_SESSION_MINUTES || 30),
          rateLimitChunksPerSecond: Number(env.MAX_AUDIO_CHUNKS_PER_SECOND || 10)
        }
      };
    }
  };
}
