export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_FRAME_SIZE = 1024;
export const CHUNK_DURATION_MS = 250;

// Quality and Latency targets from PRD
export const TARGET_LATENCY_P50_MS = 3000;
export const TARGET_LATENCY_P95_MS = 6000;
export const MAX_SUBTITLE_DRIFT_MS = 300;

// Defaults
export const DEFAULT_ORIGINAL_VOLUME = 25;
export const DEFAULT_TTS_VOLUME = 100;
export const DEFAULT_MODE = 'dubbing_and_subtitle' as const;

// Cost calculations (Public cloud rate baselines as of 2026/standard APIs)
// Speech-to-Text: ~$0.016 / minute ($0.000267 / sec)
// LLM Translation: ~$0.0005 / 1k characters
// Neural TTS: ~$0.016 / 1k characters
// Infrastructure: estimated WebSocket/compute ~$0.02 / hour
export const COST_RATES = {
  STT_PER_SECOND: 0.016 / 60,
  TRANSLATION_PER_CHAR: 0.0005 / 1000,
  TTS_PER_CHAR: 0.016 / 1000,
  INFRASTRUCTURE_PER_HOUR: 0.02,
};
