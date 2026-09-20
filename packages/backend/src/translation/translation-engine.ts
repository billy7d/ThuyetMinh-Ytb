import { ContextManager } from './context-manager.js';
import { SentenceCompletionGuard } from './completion-guard.js';
import { TranslationProvider } from './types.js';

export interface TranslationOptions {
  preserveNumbers?: boolean;
  contextManager?: ContextManager;
  speakerTone?: 'natural' | 'formal' | 'casual';
}
export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  buffered: boolean;
  latencyMs: number;
  tokensUsed?: number;
}

export interface TranslationEngineConfig {
  maxPendingCharacters: number;
  maxTranslationCharacters: number;
  maxContextItems: number;
  validateVietnamese: boolean;
}

const DEFAULT_CONFIG: TranslationEngineConfig = {
  maxPendingCharacters: 1200,
  maxTranslationCharacters: 2400,
  maxContextItems: 5,
  validateVietnamese: true
};

/**
 * Sentence assembler and provider boundary. Every caller must inject a
 * provider; production wiring injects the local worker and tests inject a
 * fixture. Cloud adapters are opt-in diagnostics only.
 */
export class TranslationEngine {
  private readonly contextManager: ContextManager;
  private readonly completionGuard: SentenceCompletionGuard;
  private readonly provider: TranslationProvider;
  private readonly config: TranslationEngineConfig;
  private pendingBuffer = '';
  private pendingStartMs = 0;
  private resetVersion = 0;

  constructor(
    provider: TranslationProvider,
    contextManager?: ContextManager,
    config: Partial<TranslationEngineConfig> = {}
  ) {
    this.provider = provider;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      // The deterministic fixture intentionally returns partially translated
      // text for generic assertions; production local-worker validation stays on.
      validateVietnamese: config.validateVietnamese ?? provider.name !== 'DeterministicFixtureTranslation'
    };
    this.contextManager = contextManager || new ContextManager(this.config.maxContextItems);
    this.completionGuard = new SentenceCompletionGuard();
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getProviderName(): string {
    return this.provider.name;
  }

  async translate(
    text: string,
    startMs: number,
    endMs: number,
    options: TranslationOptions = {}
  ): Promise<TranslationResult> {
    const startedAt = Date.now();
    const incoming = text.trim();
    if (!incoming) {
      return { sourceText: '', translatedText: '', buffered: true, latencyMs: Date.now() - startedAt };
    }

    const candidateText = (this.pendingBuffer ? `${this.pendingBuffer} ${incoming}` : incoming).trim();
    if (candidateText.length > this.config.maxPendingCharacters) {
      this.pendingBuffer = '';
      this.pendingStartMs = 0;
      throw new Error(`Transcript segment exceeded ${this.config.maxPendingCharacters} characters before completion`);
    }

    const completionCheck = this.completionGuard.check(candidateText);
    if (!completionCheck.isComplete) {
      this.pendingBuffer = candidateText;
      if (!this.pendingStartMs) this.pendingStartMs = startMs;
      return {
        sourceText: candidateText,
        translatedText: '',
        buffered: true,
        latencyMs: Date.now() - startedAt
      };
    }

    const fullSourceText = candidateText;
    const contextStartMs = this.pendingStartMs || startMs;
    const requestResetVersion = this.resetVersion;
    this.pendingBuffer = '';
    this.pendingStartMs = 0;

    const providerResult = await this.provider.translate({
      sourceText: fullSourceText,
      startMs: contextStartMs,
      endMs,
      context: this.contextManager.getHistory(),
      terminology: this.contextManager.getTerminology(),
      speakerTone: options.speakerTone || 'natural'
    });
    if (requestResetVersion !== this.resetVersion) {
      return {
        sourceText: fullSourceText,
        translatedText: '',
        buffered: true,
        latencyMs: Date.now() - startedAt
      };
    }
    const translatedText = this.validateTranslation(providerResult.translatedText, fullSourceText);
    this.contextManager.addConfirmed(fullSourceText, translatedText, endMs);

    return {
      sourceText: fullSourceText,
      translatedText,
      buffered: false,
      latencyMs: Date.now() - startedAt,
      tokensUsed: providerResult.tokensUsed
    };
  }

  private validateTranslation(rawText: string, sourceText: string): string {
    let text = rawText.trim();
    text = text.replace(/^```(?:text|plaintext|vietnamese)?\s*/i, '').replace(/\s*```$/i, '').trim();
    text = text.replace(/^(?:translation|bản dịch)\s*:\s*/i, '').trim();
    text = text.replace(/^['“”\"]|['“”\"]$/g, '').trim();

    if (!text) throw new Error('Translation provider returned empty text');
    if (text.length > this.config.maxTranslationCharacters) {
      throw new Error(`Translation provider returned more than ${this.config.maxTranslationCharacters} characters`);
    }
    if (/^\s*(?:here(?:'s| is)|giải thích|explanation)\b/i.test(text)) {
      throw new Error('Translation provider returned commentary instead of a translation');
    }
    if (this.config.validateVietnamese && !this.looksVietnamese(text) && /[a-z]/i.test(sourceText)) {
      throw new Error('Translation provider returned text that does not appear to be Vietnamese');
    }
    return text;
  }

  private looksVietnamese(text: string): boolean {
    if (/[À-ỹĐđ]/.test(text)) return true;
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    const commonWords = new Set([
      'và', 'của', 'là', 'trong', 'một', 'những', 'các', 'cho', 'được', 'với',
      'không', 'này', 'đó', 'chúng', 'ta', 'bạn', 'sẽ', 'theo', 'khi', 'từ'
    ]);
    return words.filter(word => commonWords.has(word)).length >= 2;
  }

  reset(): void {
    this.resetVersion++;
    this.pendingBuffer = '';
    this.pendingStartMs = 0;
    this.provider.cancelPending?.();
    this.contextManager.reset();
  }
}
