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

export interface TranslationProvider {
  name: string;
  translate(request: TranslationRequest): Promise<TranslationProviderResult>;
  cancelPending?(): void;
}
