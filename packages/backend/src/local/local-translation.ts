import { LocalWorkerClientLike, abortError } from './worker-client.js';
import { TranslationProvider, TranslationProviderResult, TranslationRequest } from '../translation/types.js';

export interface LocalTranslationConfig {
  modelPath: string;
  timeoutMs: number;
}

export const DEFAULT_LOCAL_TRANSLATION_CONFIG: LocalTranslationConfig = {
  modelPath: '',
  timeoutMs: 20_000
};

interface LocalTranslationResponse {
  translatedText?: string;
  tokensUsed?: number;
}

/** Local en->vi translation adapter. It has no remote fallback. */
export class LocalTranslationProvider implements TranslationProvider {
  readonly name = 'LocalOpusMTTranslation';
  private readonly config: LocalTranslationConfig;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly worker: LocalWorkerClientLike,
    config: Partial<LocalTranslationConfig> = {}
  ) {
    this.config = { ...DEFAULT_LOCAL_TRANSLATION_CONFIG, ...config };
    if (!this.config.modelPath.trim()) throw new Error('LOCAL_TRANSLATION_MODEL_PATH is required');
    if (this.config.timeoutMs < 1) throw new Error('LOCAL_TRANSLATION_TIMEOUT_MS must be positive');
  }

  async translate(request: TranslationRequest): Promise<TranslationProviderResult> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.worker.request<LocalTranslationResponse>({
        op: 'translate',
        modelPath: this.config.modelPath,
        sourceText: request.sourceText,
        startMs: request.startMs,
        endMs: request.endMs,
        context: request.context,
        terminology: request.terminology,
        speakerTone: request.speakerTone
      }, { signal: controller.signal });

      const translatedText = response.translatedText?.trim() || '';
      if (!translatedText) throw new Error('Local translation worker returned empty text');
      return { translatedText, tokensUsed: response.tokensUsed };
    } catch (error) {
      if (controller.signal.aborted) throw abortError(`Local translation timed out after ${this.config.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  cancelPending(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
