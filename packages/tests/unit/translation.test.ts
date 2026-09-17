import { describe, it, expect } from 'vitest';
import {
  ContextManager,
  SentenceCompletionGuard,
  TranslationEngine
} from '@vietdub/backend';

describe('ContextManager', () => {
  it('should maintain sliding window of confirmed sentences', () => {
    const cm = new ContextManager(3);
    cm.addConfirmed('Sentence 1', 'Câu 1', 1000);
    cm.addConfirmed('Sentence 2', 'Câu 2', 2000);
    cm.addConfirmed('Sentence 3', 'Câu 3', 3000);
    cm.addConfirmed('Sentence 4', 'Câu 4', 4000);

    const history = cm.getHistory();
    expect(history.length).toBe(3);
    expect(history[0].sourceText).toBe('Sentence 2');
    expect(history[2].sourceText).toBe('Sentence 4');
  });

  it('should manage and preserve consistent terminology', () => {
    const cm = new ContextManager();
    expect(cm.getTerm('rate cut')).toBe('cắt giảm lãi suất');
    cm.setTerm('yield curve', 'đường cong lợi suất');
    expect(cm.getTerm('yield curve')).toBe('đường cong lợi suất');
  });
});

describe('SentenceCompletionGuard', () => {
  const guard = new SentenceCompletionGuard();

  it('should reject sentences ending with dangling conjunctions or prepositions', () => {
    expect(guard.check('This is not only about money, but also').isComplete).toBe(false);
    expect(guard.check('We decided to invest because').isComplete).toBe(false);
    expect(guard.check('Looking at the chart and').isComplete).toBe(false);
  });

  it('should reject trailing ellipsis', () => {
    expect(guard.check('Wait a minute...').isComplete).toBe(false);
  });

  it('should accept complete, well-formed sentences', () => {
    expect(guard.check("Let's break it down.").isComplete).toBe(true);
    expect(guard.check("The market is pricing in a rate cut.").isComplete).toBe(true);
    expect(guard.check("It turns out we were wrong.").isComplete).toBe(true);
  });
});

describe('TranslationEngine with PRD Rule Set', () => {
  it('should correctly translate PRD reference sentences into natural spoken Vietnamese', async () => {
    const engine = new TranslationEngine();

    const r1 = await engine.translate("Let's break it down.", 0, 1000);
    expect(r1.translatedText).toBe('Chúng ta cùng phân tích kỹ hơn nhé.');

    const r2 = await engine.translate("That's not the whole story.", 1000, 2000);
    expect(r2.translatedText).toBe('Nhưng đó vẫn chưa phải là toàn bộ câu chuyện.');

    const r3 = await engine.translate("The market is pricing in a rate cut.", 2000, 3000);
    expect(r3.translatedText).toBe('Thị trường đang phản ánh kỳ vọng lãi suất sẽ được cắt giảm.');

    const r4 = await engine.translate("It turns out we were wrong.", 3000, 4000);
    expect(r4.translatedText).toBe('Hóa ra chúng ta đã nhầm.');

    const r5 = await engine.translate("I'm going to walk you through it.", 4000, 5000);
    expect(r5.translatedText).toBe('Tôi sẽ hướng dẫn bạn từng bước.');
  });

  it('should buffer incomplete thoughts until resolved', async () => {
    const engine = new TranslationEngine();

    // Partial sentence ending with 'because'
    const step1 = await engine.translate("We stopped the project because", 0, 1000);
    expect(step1.buffered).toBe(true);
    expect(step1.translatedText).toBe('');

    // Follow-up completion
    const step2 = await engine.translate("it was too expensive.", 1000, 2500);
    expect(step2.buffered).toBe(false);
    expect(step2.sourceText).toBe('We stopped the project because it was too expensive.');
    expect(step2.translatedText).toBeTruthy();
  });
});
