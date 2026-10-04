import { ContextManager } from './context-manager.js';

export interface TranslationRequest {
  sourceText: string;
  startMs: number;
  endMs: number;
  context: ReturnType<ContextManager['getHistory']>;
  terminology: Record<string, string>;
  speakerTone: 'natural' | 'formal' | 'casual';
}

export interface TranslationProviderResult {
  translatedText: string;
  tokensUsed?: number;
}

/** Câu đã thêm dấu câu từ phụ đề tự động (mốc video, ms). */
export interface PunctuatedSentence {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranslationProvider {
  name: string;
  translate(request: TranslationRequest): Promise<TranslationProviderResult>;
  /** Thêm dấu câu + tách câu cho phụ đề tự động (từ kèm mốc thời gian). Không có thì không hỗ trợ phụ đề tự động. */
  punctuate?(words: Array<{ text: string; startMs: number }>): Promise<PunctuatedSentence[]>;
  cancelPending?(): void;
}
