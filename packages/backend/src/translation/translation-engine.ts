import { ContextManager } from './context-manager.js';
import { NO_FINAL_PUNCTUATION, SentenceCompletionGuard, endsWithOpenWord } from './completion-guard.js';
import { TranslationProvider } from './types.js';

export interface TranslationOptions {
  /** Đoạn nguồn bị cắt giữa lúc người nói chưa ngừng: coi là chưa trọn câu dù có dấu chấm cuối. */
  endedMidSpeech?: boolean;
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
  /** Mốc bắt đầu (video ms) của toàn bộ đoạn nguồn đã gộp để dịch. */
  startMs?: number;
  /** Mốc kết thúc (video ms) của đoạn nguồn đã dịch. */
  endMs?: number;
}

export interface TranslationEngineConfig {
  maxPendingCharacters: number;
  maxTranslationCharacters: number;
  maxContextItems: number;
  validateVietnamese: boolean;
  /** Đoạn chưa trọn câu được giữ tối đa chừng này thời gian video rồi buộc dịch, tránh phụ đề bị treo. */
  maxPendingDurationMs: number;
  /** Đoạn chưa trọn câu dài tới ngưỡng ký tự này thì buộc dịch. */
  forceFlushCharacters: number;
  /** Mảnh câu cụt đang giữ mà câu kế tiếp bắt đầu sau hơn chừng này (ms video) thì bỏ, không ghép nhầm sang câu khác. */
  maxPendingGapMs: number;
  /**
   * Đoạn không có dấu câu cuối nhưng đủ dài vẫn dịch ngay (cách cũ). Mặc định tắt: dịch riêng mảnh dở như
   * "So instead of trying to fix everything at once" cho ra câu tiếng Việt cụt, làm giọng đọc ngắt sai chỗ và đổi nghĩa.
   */
  flushUnpunctuated: boolean;
}

const DEFAULT_CONFIG: TranslationEngineConfig = {
  maxPendingCharacters: 1200,
  maxTranslationCharacters: 2400,
  maxContextItems: 5,
  validateVietnamese: true,
  // Đủ cho một mảnh bị cắt (≤5 s) cộng phần nối tiếp; câu dài hơn vẫn bị buộc dịch để không treo.
  maxPendingDurationMs: 8_000,
  forceFlushCharacters: 300,
  maxPendingGapMs: 3_000,
  flushUnpunctuated: false
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
  private pendingStartMs: number | null = null;
  private pendingEndMs = 0;
  private pendingEndedMidSpeech = false;
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

    if (this.pendingBuffer && startMs - this.pendingEndMs > this.config.maxPendingGapMs) {
      // Câu nối tiếp không tới kịp: mảnh cụt đang giữ thuộc về một lượt nói đã qua, không ghép với câu mới.
      this.pendingBuffer = '';
      this.pendingStartMs = null;
      this.pendingEndedMidSpeech = false;
    }
    const candidateText = (this.pendingBuffer
      ? joinFragments(this.pendingBuffer, this.pendingEndedMidSpeech, incoming)
      : incoming).trim();
    if (candidateText.length > this.config.maxPendingCharacters) {
      this.pendingBuffer = '';
      this.pendingStartMs = null;
      throw new Error(`Transcript segment exceeded ${this.config.maxPendingCharacters} characters before completion`);
    }

    const completionCheck = options.endedMidSpeech
      ? { isComplete: false, reason: 'Cut while the speaker was still talking' }
      : this.completionGuard.check(candidateText);
    const pendingSinceMs = this.pendingStartMs ?? startMs;
    const mustFlush = candidateText.length >= this.config.forceFlushCharacters
      || endMs - pendingSinceMs >= this.config.maxPendingDurationMs
      || (this.config.flushUnpunctuated
        && completionCheck.reason === NO_FINAL_PUNCTUATION
        && this.completionGuard.isTranslatableWithoutPunctuation(candidateText));
    if (!completionCheck.isComplete && !mustFlush) {
      this.pendingBuffer = candidateText;
      if (this.pendingStartMs === null) this.pendingStartMs = startMs;
      this.pendingEndMs = endMs;
      this.pendingEndedMidSpeech = Boolean(options.endedMidSpeech);
      return {
        sourceText: candidateText,
        translatedText: '',
        buffered: true,
        latencyMs: Date.now() - startedAt
      };
    }

    return this.translateNow(candidateText, this.pendingStartMs ?? startMs, endMs, options, startedAt);
  }

  hasPending(): boolean {
    return this.pendingBuffer.length > 0;
  }

  /** Có mảnh câu đang giữ đủ dài để dịch riêng (mảnh quá ngắn thì chỉ chờ câu nối tiếp). */
  hasFlushablePending(): boolean {
    return this.pendingBuffer.length > 0 && !this.completionGuard.isTinyFragment(this.pendingBuffer);
  }

  /**
   * Dịch ngay mảnh câu đang giữ (pipeline gọi khi không có câu nối tiếp trong một khoảng ngắn),
   * để mảnh câu cuối của một lượt nói không bị treo tới câu sau.
   */
  async flushPending(options: TranslationOptions = {}): Promise<TranslationResult> {
    const startedAt = Date.now();
    const pending = this.pendingBuffer.trim();
    if (!pending || this.completionGuard.isTinyFragment(pending)) {
      return { sourceText: '', translatedText: '', buffered: true, latencyMs: 0 };
    }
    return this.translateNow(pending, this.pendingStartMs ?? this.pendingEndMs, this.pendingEndMs, options, startedAt);
  }

  private async translateNow(
    fullSourceText: string,
    contextStartMs: number,
    endMs: number,
    options: TranslationOptions,
    startedAt: number
  ): Promise<TranslationResult> {
    const requestResetVersion = this.resetVersion;
    this.pendingBuffer = '';
    this.pendingStartMs = null;
    this.pendingEndedMidSpeech = false;

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
      tokensUsed: providerResult.tokensUsed,
      startMs: contextStartMs,
      endMs
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
      // Câu cực ngắn ("Oh.", "Yeah.", tên riêng) model giữ nguyên tiếng Anh: không có gì để thuyết minh, bỏ qua lặng lẽ
      // (pipeline coi "contains no speech" là bỏ qua, không phải lỗi hiển thị cho người dùng).
      if (sourceText.trim().split(/\s+/).length <= 3) throw new Error('Translation contains no speech to dub');
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
    this.pendingStartMs = null;
    this.pendingEndedMidSpeech = false;
    this.provider.cancelPending?.();
    this.contextManager.reset();
  }
}

/** Từ đầu câu có thể viết thường khi nối vào giữa câu ("We" -> "we"); không gồm "I" và tên riêng. */
const SAFE_LOWERCASE_STARTERS = new Set([
  'the', 'a', 'an', 'we', 'you', 'they', 'it', 'he', 'she', 'this', 'that', 'these', 'those', 'and', 'but', 'so', 'if',
  'when', 'then', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'what', 'how', 'because', 'which', 'who', 'there', 'our', 'your', 'their', 'even', 'also', 'just', 'still', 'now', 'or', 'not', 'my'
]);

/**
 * Nối mảnh câu đang giữ với đoạn nối tiếp.
 * - Mảnh bị cắt giữa lúc đang nói: dấu chấm cuối do Whisper tự thêm là sai, bỏ nó.
 * - Mảnh không có dấu câu cuối (người nói ngừng giữa câu): thêm dấu phẩy để model dịch thấy mệnh đề phụ + mệnh đề chính.
 * Chữ đầu đoạn sau được viết thường nếu an toàn, để thành một câu liền mạch thay vì hai câu cụt.
 */
export function joinFragments(previous: string, previousEndedMidSpeech: boolean, next: string): string {
  let head = previous.trim();
  let tail = next.trim();
  let separator = ' ';
  if (previousEndedMidSpeech) {
    head = head.replace(/\s*(?:\.{3}|…|\.)\s*$/, '');
  } else if (!/[.!?…,;:)"”']$/.test(head) && !endsWithOpenWord(head)) {
    separator = ', ';
  }
  if (previousEndedMidSpeech || separator === ', ') {
    const first = tail.split(/\s+/)[0]?.replace(/[^A-Za-z']/g, '');
    if (first && first !== first.toLowerCase() && SAFE_LOWERCASE_STARTERS.has(first.toLowerCase())) {
      tail = tail.charAt(0).toLowerCase() + tail.slice(1);
    }
  }
  return `${head}${separator}${tail}`;
}
