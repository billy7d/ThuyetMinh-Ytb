import { generateSyntheticWavBuffer, TTSProvider, TTSRequest, TTSResponse } from '@vietdub/backend';

/** Test-only audio provider. Production never imports this fixture. */
export class FixtureTTSProvider implements TTSProvider {
  readonly name = 'FixtureTTS';
  private cancelled = new Set<number>();

  cancelGeneration(generation: number): void {
    this.cancelled.add(generation);
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    if (this.cancelled.has(request.generation)) {
      return {
        segmentId: request.segmentId,
        generation: request.generation,
        audioBase64: '',
        mimeType: 'audio/wav',
        durationMs: 0,
        sampleRate: 16000,
        channels: 1,
        cancelled: true
      };
    }
    const durationSeconds = Math.max(0.8, request.text.trim().length / 16);
    const buffer = generateSyntheticWavBuffer(durationSeconds, 16000, 240);
    return {
      segmentId: request.segmentId,
      generation: request.generation,
      audioBase64: buffer.toString('base64'),
      mimeType: 'audio/wav',
      durationMs: Math.round(durationSeconds * 1000),
      sampleRate: 16000,
      channels: 1,
      cancelled: false
    };
  }
}
