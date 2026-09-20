import { COST_RATES, SessionMetrics } from '@vietdub/shared';

export interface BudgetConfig {
  maxCostPerSessionUsd: number;
  maxSessionMinutes: number;
  rateLimitChunksPerSecond: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxCostPerSessionUsd: 2.0, // Hard stop if session exceeds $2.00
  maxSessionMinutes: 30, // Default test/session ceiling from the PRD safety budget
  rateLimitChunksPerSecond: 10
};

export class CostTracker {
  private sessionId: string;
  private startTime: number;
  private config: BudgetConfig;

  private sttSeconds: number = 0;
  private translatedCharacters: number = 0;
  private ttsCharacters: number = 0;
  private audioFramesProcessed: number = 0;

  private chunkTimestamps: number[] = [];

  constructor(sessionId: string, config: Partial<BudgetConfig> = {}) {
    this.sessionId = sessionId;
    this.startTime = Date.now();
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  recordAudioChunk(durationSeconds: number): boolean {
    // Rate limit check
    const now = Date.now();
    this.chunkTimestamps.push(now);
    this.chunkTimestamps = this.chunkTimestamps.filter(t => now - t <= 1000);

    if (this.chunkTimestamps.length > this.config.rateLimitChunksPerSecond) {
      throw new Error(`[CostTracker] Rate limit exceeded: ${this.chunkTimestamps.length} chunks/sec`);
    }

    this.audioFramesProcessed++;
    this.sttSeconds += durationSeconds;
    this.checkBudget();
    return true;
  }

  recordTranslation(characters: number): void {
    this.translatedCharacters += characters;
    this.checkBudget();
  }

  recordTTS(characters: number): void {
    this.ttsCharacters += characters;
    this.checkBudget();
  }

  getMetrics(): SessionMetrics {
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const elapsedHours = elapsedSeconds / 3600;

    const sttCost = this.sttSeconds * COST_RATES.STT_PER_SECOND;
    const transCost = this.translatedCharacters * COST_RATES.TRANSLATION_PER_CHAR;
    const ttsCost = this.ttsCharacters * COST_RATES.TTS_PER_CHAR;
    const infraCost = elapsedHours * COST_RATES.INFRASTRUCTURE_PER_HOUR;

    const estimatedCostUsd = sttCost + transCost + ttsCost + infraCost;

    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      elapsedSeconds: Math.round(elapsedSeconds),
      audioFramesProcessed: this.audioFramesProcessed,
      sttSeconds: Math.round(this.sttSeconds * 10) / 10,
      translatedCharacters: this.translatedCharacters,
      ttsCharacters: this.ttsCharacters,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000
    };
  }

  private checkBudget(): void {
    const metrics = this.getMetrics();
    if (metrics.elapsedSeconds > this.config.maxSessionMinutes * 60) {
      throw new Error(
        `[CostTracker] Session duration limit of ${this.config.maxSessionMinutes} minutes exceeded`
      );
    }
    if (metrics.estimatedCostUsd > this.config.maxCostPerSessionUsd) {
      throw new Error(
        `[CostTracker] Budget guard triggered! Session cost $${metrics.estimatedCostUsd.toFixed(4)} exceeded limit of $${this.config.maxCostPerSessionUsd.toFixed(2)}`
      );
    }
  }

  /**
   * Static projection formula: Total Cost = STT + Translation + TTS + Infra
   * Computes expected cost for 1 hour of video.
   */
  static calculateOneHourCostProjection(assumptions: {
    wordsPerMinute?: number;
    speechRatio?: number; // e.g. 0.8 = 80% talking, 20% music/silence
  } = {}) {
    const speechRatio = assumptions.speechRatio ?? 0.75;
    const wordsPerMin = assumptions.wordsPerMinute ?? 140;

    const totalSeconds = 3600;
    const speechSeconds = totalSeconds * speechRatio;
    const speechMinutes = speechSeconds / 60;
    const totalWords = speechMinutes * wordsPerMin;
    const englishChars = totalWords * 5.5; // ~5.5 chars per English word
    const vietnameseChars = totalWords * 6.5; // Vietnamese expansion factor ~1.15 - 1.20

    const sttCost = speechSeconds * COST_RATES.STT_PER_SECOND;
    const translationCost = englishChars * COST_RATES.TRANSLATION_PER_CHAR;
    const ttsCost = vietnameseChars * COST_RATES.TTS_PER_CHAR;
    const infraCost = 1.0 * COST_RATES.INFRASTRUCTURE_PER_HOUR;

    const totalCost = sttCost + translationCost + ttsCost + infraCost;

    return {
      durationHours: 1,
      speechMinutes: Math.round(speechMinutes),
      totalWords: Math.round(totalWords),
      sttCostUsd: Math.round(sttCost * 1000) / 1000,
      translationCostUsd: Math.round(translationCost * 1000) / 1000,
      ttsCostUsd: Math.round(ttsCost * 1000) / 1000,
      infraCostUsd: Math.round(infraCost * 1000) / 1000,
      totalCostUsd: Math.round(totalCost * 1000) / 1000,
      breakdownPercentage: {
        stt: Math.round((sttCost / totalCost) * 100),
        translation: Math.round((translationCost / totalCost) * 100),
        tts: Math.round((ttsCost / totalCost) * 100),
        infra: Math.round((infraCost / totalCost) * 100)
      }
    };
  }
}
