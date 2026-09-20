import { TTSProvider, TTSRequest, TTSResponse } from './types.js';

/**
 * Compatibility wrapper that adds a stable product-facing name around an
 * injected real TTS provider. It deliberately has no synthetic fallback.
 */
export class VietnameseTTSEngine implements TTSProvider {
  name = 'VietnameseTTSEngine';
  constructor(private readonly provider: TTSProvider) {}

  cancelGeneration(generation: number): void {
    this.provider.cancelGeneration(generation);
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    return this.provider.synthesize(request);
  }
}
