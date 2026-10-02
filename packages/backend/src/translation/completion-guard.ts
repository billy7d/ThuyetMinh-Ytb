export interface CompletionCheckResult {
  isComplete: boolean;
  reason?: string;
}

export const NO_FINAL_PUNCTUATION = 'No sentence-final punctuation';

/** Từ kết thúc cho thấy mảnh câu còn dở (mạo từ, giới từ, trợ động từ…), chỉ xét khi không có dấu câu. */
const FRAGMENT_END_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'by', 'from', 'my', 'your', 'our', 'their', 'his', 'her', 'its',
  'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'will', 'would', 'can', 'could',
  'should', 'must', 'have', 'has', 'had', 'do', 'does', 'did', 'not', 'very', 'really', 'more', 'most',
  "i'm", "it's", "we're", "you're", "they're", "there's", 'i', 'we', 'you', 'they', 'he', 'she', 'it'
]);

/** Số từ tối thiểu để một đoạn không dấu câu vẫn đủ nghĩa để dịch ngay (không chờ câu sau). */
export const MIN_WORDS_WITHOUT_PUNCTUATION = 6;

/**
 * Mảnh câu cụt tối đa chừng này từ ("There will be a") dịch riêng ra chuỗi vô nghĩa ("Sẽ có Rồi sẽ có"),
 * nên không bao giờ dịch riêng: chờ câu nối tiếp hoặc bỏ nếu câu nối tiếp không tới kịp.
 */
export const MAX_TINY_FRAGMENT_WORDS = 4;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export class SentenceCompletionGuard {
  // Conjunctions and prepositions at the end of a sentence indicating continuation
  private trailingDanglingWords = new Set([
    'and', 'but', 'or', 'so', 'because', 'although', 'though', 'even',
    'which', 'that', 'who', 'whom', 'whose', 'where', 'when', 'while',
    'if', 'unless', 'since', 'whether', 'as', 'than', 'to', 'for', 'with',
    'about', 'like', 'such', 'into', 'onto', 'upon'
  ]);

  private trailingPhrases = [
    'not only', 'but also', 'as well as', 'in order to', 'so that',
    'on the other hand', 'due to', 'instead of', 'rather than'
  ];

  /** Mảnh câu quá ngắn và chưa có dấu kết thúc: dịch riêng không có nghĩa. */
  isTinyFragment(text: string): boolean {
    const trimmed = text.trim();
    return countWords(trimmed) <= MAX_TINY_FRAGMENT_WORDS && !/[.!?…"”')\]]$/.test(trimmed);
  }

  /**
   * Đoạn thiếu dấu câu nhưng đủ dài và không dừng ở từ nối/mạo từ vẫn được dịch ngay: chờ câu sau
   * làm phụ đề trễ thêm nhiều giây, trong khi bản dịch gần như không đổi.
   */
  isTranslatableWithoutPunctuation(text: string): boolean {
    const words = text.trim().toLowerCase().replace(/[,;:\-–—]+$/, '').split(/\s+/).filter(Boolean);
    if (words.length < MIN_WORDS_WITHOUT_PUNCTUATION) return false;
    const lastWord = words[words.length - 1].replace(/[^a-z']/g, '');
    return !FRAGMENT_END_WORDS.has(lastWord) && !this.trailingDanglingWords.has(lastWord);
  }

  check(text: string): CompletionCheckResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { isComplete: false, reason: 'Empty string' };
    }

    // Check for ellipsis at end
    if (trimmed.endsWith('...') || trimmed.endsWith('…')) {
      return { isComplete: false, reason: 'Trailing ellipsis' };
    }

    const lower = trimmed.toLowerCase();

    // Check trailing multi-word phrases
    for (const phrase of this.trailingPhrases) {
      if (lower.endsWith(phrase)) {
        return { isComplete: false, reason: `Trailing phrase: "${phrase}"` };
      }
    }

    // Check last word
    const words = lower.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').split(/\s+/);
    const lastWord = words[words.length - 1];

    if (this.trailingDanglingWords.has(lastWord)) {
      return { isComplete: false, reason: `Dangling conjunction/preposition: "${lastWord}"` };
    }

    // Check balanced quotes and parentheses
    const openParens = (trimmed.match(/\(/g) || []).length;
    const closeParens = (trimmed.match(/\)/g) || []).length;
    if (openParens > closeParens) {
      return { isComplete: false, reason: 'Unclosed parenthesis' };
    }

    // Whisper luôn thêm dấu câu cho câu đã nói xong; mảnh bị cắt giữa chừng ("There will be a")
    // nếu dịch riêng lẻ sẽ ra câu tiếng Việt sai nghĩa. Engine vẫn buộc dịch sau giới hạn thời gian/độ dài.
    if (!/[.!?…"”')\]]$/.test(trimmed)) {
      return { isComplete: false, reason: NO_FINAL_PUNCTUATION };
    }

    return { isComplete: true };
  }
}
