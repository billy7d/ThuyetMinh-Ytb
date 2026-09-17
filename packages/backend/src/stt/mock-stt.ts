import { STTProvider, STTStreamCallbacks, STTStreamSession } from './types.js';
import { SimpleVAD } from './vad.js';

export class MockSTTProvider implements STTProvider {
  name = 'MockSTTProvider';
  private predefinedSentences: string[];
  private currentIndex = 0;

  constructor(customSentences?: string[]) {
    this.predefinedSentences = customSentences || [
      "Let's break it down.",
      "That's not the whole story.",
      "The market is pricing in a rate cut.",
      "It turns out we were wrong.",
      "I'm going to walk you through it."
    ];
  }

  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    const vad = new SimpleVAD();
    let accumulatedPcmBytes = 0;
    let streamActive = true;
    let interimSent = false;
    let speechStartMs = 0;

    return {
      sendAudioChunk: (pcmData: Buffer, timestampMs: number) => {
        if (!streamActive) return;

        accumulatedPcmBytes += pcmData.length;
        const vadResult = vad.process(pcmData, timestampMs);

        if (vadResult.speechStarted) {
          speechStartMs = timestampMs;
          interimSent = false;
        }

        // Simulate interim transcript after 300ms of speech
        if (vad.process(pcmData, timestampMs).isVoice && !interimSent && timestampMs - speechStartMs > 300) {
          interimSent = true;
          const sentence = this.predefinedSentences[this.currentIndex % this.predefinedSentences.length];
          const words = sentence.split(' ');
          const interimWords = words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(' ');
          callbacks.onInterim(interimWords, speechStartMs, timestampMs);
        }

        // When VAD detects speech end (silence boundary)
        if (vadResult.speechEnded) {
          const finalSentence = this.predefinedSentences[this.currentIndex % this.predefinedSentences.length];
          this.currentIndex++;
          callbacks.onFinal(finalSentence, vadResult.startMs, vadResult.endMs);
          interimSent = false;
        }
      },

      endStream: () => {
        streamActive = false;
        vad.reset();
      }
    };
  }

  setTestSentences(sentences: string[]): void {
    this.predefinedSentences = sentences;
    this.currentIndex = 0;
  }
}
