import { TranslationProvider, TranslationProviderResult, TranslationRequest } from './types.js';

/**
 * Deterministic fixture provider used only by unit/integration tests. It is
 * intentionally not wired into the production provider factory.
 */
export class DeterministicTranslationProvider implements TranslationProvider {
  readonly name = 'DeterministicFixtureTranslation';

  private static readonly IDIOM_MAP: Array<{ regex: RegExp; vi: string }> = [
    { regex: /^let'?s break it down\.?$/i, vi: 'Chúng ta cùng phân tích kỹ hơn nhé.' },
    { regex: /^that'?s not the whole story\.?$/i, vi: 'Nhưng đó vẫn chưa phải là toàn bộ câu chuyện.' },
    { regex: /^the market is pricing in a rate cut\.?$/i, vi: 'Thị trường đang phản ánh kỳ vọng lãi suất sẽ được cắt giảm.' },
    { regex: /^it turns out we were wrong\.?$/i, vi: 'Hóa ra chúng ta đã nhầm.' },
    { regex: /^i'?m going to walk you through it\.?$/i, vi: 'Tôi sẽ hướng dẫn bạn từng bước.' },
    { regex: /^at the end of the day\.?$/i, vi: 'Sau cùng thì,' },
    { regex: /^to make a long story short\.?$/i, vi: 'Nói một cách ngắn gọn thì,' },
    { regex: /^keep in mind that\.?$/i, vi: 'Hãy nhớ rằng,' },
    { regex: /^in other words\.?$/i, vi: 'Nói cách khác,' },
    { regex: /^as a matter of fact\.?$/i, vi: 'Trên thực tế,' }
  ];

  async translate(request: TranslationRequest): Promise<TranslationProviderResult> {
    const trimmed = request.sourceText.trim();
    const idiom = DeterministicTranslationProvider.IDIOM_MAP.find(item => item.regex.test(trimmed));
    if (idiom) return { translatedText: idiom.vi, tokensUsed: Math.ceil(trimmed.length / 4) };

    let result = trimmed;
    for (const [english, vietnamese] of Object.entries(request.terminology)) {
      result = result.replace(new RegExp(`\\b${escapeRegExp(english)}\\b`, 'gi'), vietnamese);
    }
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
    for (const [pattern, replacement] of phraseMap) result = result.replace(pattern, replacement);
    return { translatedText: result, tokensUsed: Math.ceil(trimmed.length / 4) };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
