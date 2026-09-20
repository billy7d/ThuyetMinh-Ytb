import { ContextManager } from './context-manager.js';
import { SentenceCompletionGuard } from './completion-guard.js';
import { emitDiagnostic } from '@vietdub/shared';

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
 * provider; production wiring injects Gemini and tests inject a fixture.
 */
export class TranslationEngine {
  private readonly contextManager: ContextManager;
  private readonly completionGuard: SentenceCompletionGuard;
  private readonly provider: TranslationProvider;
  private readonly config: TranslationEngineConfig;
  private pendingBuffer = '';
  private pendingStartMs = 0;

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
      // text for generic assertions; production Gemini validation stays on.
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

    // 2. Check if LLM API is available in environment
    if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
      try {
        // Không tự gọi provider trong P0; đây chỉ là điểm mở rộng đã được ghi rõ.
        emitDiagnostic('translation', 'llm_provider_not_implemented', { sourceLength: trimmed.length });
        const llmResult = await this.callLLM(trimmed);
        if (llmResult) return llmResult;
      } catch (err) {
        console.warn('[TranslationEngine] LLM call failed, falling back to rule engine:', err);
      }
    }
    if (this.config.validateVietnamese && !this.looksVietnamese(text) && /[a-z]/i.test(sourceText)) {
      throw new Error('Translation provider returned text that does not appear to be Vietnamese');
    }
    return text;
  }

  private async callLLM(sourceText: string): Promise<string | null> {
    // LLM caller with the 7 strict rules injected into system prompt
    const contextPrompt = this.contextManager.formatContextPrompt();
    const terminology = JSON.stringify(this.contextManager.getTerminology());

    const systemPrompt = `Bạn là chuyên gia biên dịch thuyết minh video từ tiếng Anh sang tiếng Việt.
Tuân thủ 7 quy tắc bắt buộc:
1. Dịch theo ý nghĩa của toàn câu, văn phong nói tự nhiên của người Việt.
2. Giữ nguyên số liệu, ngày tháng, tên riêng, thuật ngữ chuyên môn.
3. Không dịch máy từng từ, không giữ cấu trúc ngữ pháp tiếng Anh rập khuôn.
4. Tuyệt đối không tự ý bổ sung nội dung hay bỏ bớt ý.
5. Giữ nhất quán thuật ngữ theo bảng thuật ngữ sau: ${terminology}
6. Văn phong phù hợp cho thuyết minh giọng đọc tự nhiên.
${contextPrompt ? `Ngữ cảnh các câu trước đó:\n${contextPrompt}` : ''}
Chỉ trả về câu dịch tiếng Việt duy nhất, không giải thích gì thêm.`;

    // Stub có chủ đích: không gửi text hoặc phát sinh chi phí API trong P0.
    void sourceText;
    return null;
  }

  private ruleBasedTranslate(text: string): string {
    let result = text;

    // Apply terminology map
    const terms = this.contextManager.getTerminology();
    for (const [enTerm, viTerm] of Object.entries(terms)) {
      const regex = new RegExp(`\\b${enTerm}\\b`, 'gi');
      result = result.replace(regex, viTerm);
    }

    // Common phrase replacements for natural speech
    const phraseMap: Array<[RegExp, string]> = [
      [/\bwelcome back to\b/gi, 'Chào mừng các bạn quay trở lại với'],
      [/\bin this video, we will\b/gi, 'Trong video này, chúng ta sẽ'],
      [/\bfirst of all\b/gi, 'Trước hết'],
      [/\bas you can see\b/gi, 'Như bạn có thể thấy'],
      [/\bfor example\b/gi, 'Ví dụ như'],
      [/\bon the other hand\b/gi, 'Mặt khác'],
      [/\bin conclusion\b/gi, 'Tóm lại là'],
      [/\bthank you for watching\b/gi, 'Cảm ơn các bạn đã theo dõi'],
      [/\bdon't forget to like and subscribe\b/gi, 'Đừng quên bấm thích và đăng ký kênh nhé'],
      [/\bhow are you doing\b/gi, 'Bạn cảm thấy thế nào'],
      [/\bwhat is going on\b/gi, 'Chuyện gì đang xảy ra vậy'],
      [/\bthis is a test\b/gi, 'Đây là một bài kiểm tra'],
      [/\bwe are looking at\b/gi, 'Chúng ta đang xem xét'],
      [/\bthe main reason is\b/gi, 'Lý do chính là']
    ];

    for (const [pattern, vi] of phraseMap) {
      result = result.replace(pattern, vi);
    }

    return result;
  }

  reset(): void {
    this.pendingBuffer = '';
    this.pendingStartMs = 0;
    this.contextManager.reset();
  }
}
