import { TTSProvider, TTSRequest, TTSResponse } from './types.js';
import { generateSyntheticWavBuffer } from './wav-generator.js';

export class VietnameseTTSEngine implements TTSProvider {
  name = 'VietnameseTTSEngine';
  private cancelledGenerations = new Set<number>();
  private activeGeneration = 1;

  constructor() {}

  setGeneration(generation: number): void {
    this.activeGeneration = generation;
  }

  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation);
  }

  /**
   * Synthesize Vietnamese audio chunk with cancellation awareness.
   */
  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    // Check if this generation was cancelled
    if (this.cancelledGenerations.has(request.generation) || request.generation < this.activeGeneration) {
      return {
        segmentId: request.segmentId,
        generation: request.generation,
        audioBase64: '',
        durationMs: 0,
        sampleRate: 16000,
        cancelled: true
      };
    }

    // Estimate spoken duration based on Vietnamese character length (~15-18 chars per second)
    const textLength = request.text.trim().length;
    const durationSeconds = Math.max(0.8, textLength / 16.0);
    const durationMs = Math.round(durationSeconds * 1000);

    // If external cloud TTS is configured (e.g. Google Cloud TTS / Edge TTS), call it here
    if (process.env.GCP_TTS_API_KEY) {
      // Cloud TTS call stub
    }

    // Generate valid acoustic audio chunk
    const wavBuffer = generateSyntheticWavBuffer(durationSeconds, 16000, 240);
    const audioBase64 = wavBuffer.toString('base64');

    // Double check cancellation before returning
    if (this.cancelledGenerations.has(request.generation) || request.generation < this.activeGeneration) {
      return {
        segmentId: request.segmentId,
        generation: request.generation,
        audioBase64: '',
        durationMs: 0,
        sampleRate: 16000,
        cancelled: true
      };
    }

    return {
      segmentId: request.segmentId,
      generation: request.generation,
      audioBase64,
      durationMs,
      sampleRate: 16000,
      cancelled: false
    };
  }

  reset(): void {
    this.cancelledGenerations.clear();
    this.activeGeneration = 1;
  }
}
