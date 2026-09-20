export interface VADConfig {
  sampleRate: number;
  energyThreshold: number; // RMS threshold for speech
  silenceDurationMs: number; // Duration of silence to trigger end of utterance
  minSpeechDurationMs: number; // Minimum speech duration to consider valid
}

export const DEFAULT_VAD_CONFIG: VADConfig = {
  sampleRate: 16000,
  energyThreshold: 0.015,
  silenceDurationMs: 650,
  minSpeechDurationMs: 400
};

export class SimpleVAD {
  private config: VADConfig;
  private isSpeaking = false;
  private speechStartMs = 0;
  private lastSpeechMs = 0;
  private accumulatedSpeechMs = 0;

  constructor(config: Partial<VADConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  /**
   * Process a 16-bit signed integer PCM buffer
   * Returns: { isVoice: boolean, speechEnded: boolean, startMs: number, endMs: number }
   */
  process(pcmBuffer: Buffer, currentTimestampMs: number): {
    isVoice: boolean;
    speechStarted: boolean;
    speechEnded: boolean;
    startMs: number;
    endMs: number;
    rms: number;
  } {
    const numSamples = Math.floor(pcmBuffer.length / 2);
    if (numSamples === 0) {
      return {
        isVoice: false,
        speechStarted: false,
        speechEnded: false,
        startMs: this.speechStartMs,
        endMs: currentTimestampMs,
        rms: 0
      };
    }

    let sumSquares = 0;

    for (let i = 0; i < numSamples * 2; i += 2) {
      const sample = pcmBuffer.readInt16LE(i) / 32768.0;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / numSamples);
    const hasVoice = rms >= this.config.energyThreshold;
    const chunkDurationMs = (numSamples / this.config.sampleRate) * 1000;

    let speechStarted = false;
    let speechEnded = false;
    let outStartMs = this.speechStartMs;
    let outEndMs = currentTimestampMs;

    if (hasVoice) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartMs = currentTimestampMs;
        speechStarted = true;
      }
      this.lastSpeechMs = currentTimestampMs;
      this.accumulatedSpeechMs += chunkDurationMs;
    } else {
      if (this.isSpeaking) {
        const silenceElapsed = currentTimestampMs - this.lastSpeechMs;
        if (silenceElapsed >= this.config.silenceDurationMs) {
          // Check if speech was long enough
          if (this.accumulatedSpeechMs >= this.config.minSpeechDurationMs) {
            speechEnded = true;
            outStartMs = this.speechStartMs;
            outEndMs = this.lastSpeechMs;
          }
          // Reset
          this.isSpeaking = false;
          this.accumulatedSpeechMs = 0;
        }
      }
    }

    return {
      isVoice: hasVoice,
      speechStarted,
      speechEnded,
      startMs: outStartMs,
      endMs: outEndMs,
      rms
    };
  }

  reset(): void {
    this.isSpeaking = false;
    this.speechStartMs = 0;
    this.lastSpeechMs = 0;
    this.accumulatedSpeechMs = 0;
  }
}
