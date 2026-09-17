export interface CompletionCheckResult {
  isComplete: boolean;
  reason?: string;
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

    return { isComplete: true };
  }
}
