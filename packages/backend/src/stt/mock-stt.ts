import { STTProvider, STTStreamCallbacks, STTStreamSession } from './types.js';
import { SimpleVAD } from './vad.js';
import { diagnosticSessionRef, emitDiagnostic } from '@vietdub/shared';

export class MockSTTProvider implements STTProvider {
  name = 'MockSTTProvider';
  private predefinedSentences: string[];
  private currentIndex = 0;

  // Mock cần chốt đoạn nói liên tục để browser acceptance không phụ thuộc vào khoảng lặng của video.
  private static readonly MAX_SPEECH_SEGMENT_MS = 1500;

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
    let streamActive = true;
    let interimSent = false;
    let speechStartMs = 0;
    let hasActiveSpeech = false;
    const sessionRef = diagnosticSessionRef(sessionId);

    const emitFinalSentence = (startMs: number, endMs: number, reason: 'vad_silence' | 'max_duration'): void => {
      const finalSentence = this.predefinedSentences[this.currentIndex % this.predefinedSentences.length];
      this.currentIndex++;
      emitDiagnostic('stt', 'transcript_final_ready', {
        sessionRef,
        startMs,
        endMs,
        textLength: finalSentence.length,
        reason
      });
      callbacks.onFinal(finalSentence, startMs, endMs);
      interimSent = false;
      hasActiveSpeech = false;
      speechStartMs = 0;
      // Boundary cưỡng bức không đi qua nhánh silence của VAD nên phải reset state nội bộ.
      vad.reset();
    };

    return {
      sendAudioChunk: (pcmData: Buffer, timestampMs: number) => {
        if (!streamActive) return;

        // Mỗi chunk chỉ được đưa qua VAD một lần để không làm sai trạng thái tích lũy.
        const vadResult = vad.process(pcmData, timestampMs);
        emitDiagnostic('stt', 'vad_chunk', {
          sessionRef,
          timestampMs,
          pcmBytes: pcmData.length,
          rms: Math.round(vadResult.rms * 10000) / 10000,
          isVoice: vadResult.isVoice,
          speechStarted: vadResult.speechStarted,
          speechEnded: vadResult.speechEnded
        });

        if (vadResult.speechStarted) {
          speechStartMs = timestampMs;
          hasActiveSpeech = true;
          interimSent = false;
        }

        // Simulate interim transcript after 300ms of speech
        if (vadResult.isVoice && !interimSent && timestampMs - speechStartMs > 300) {
          interimSent = true;
          const sentence = this.predefinedSentences[this.currentIndex % this.predefinedSentences.length];
          const words = sentence.split(' ');
          const interimWords = words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(' ');
          callbacks.onInterim(interimWords, speechStartMs, timestampMs);
        }

        // When VAD detects speech end (silence boundary)
        if (vadResult.speechEnded) {
          emitFinalSentence(vadResult.startMs, vadResult.endMs, 'vad_silence');
          return;
        }

        // Video nhạc hoặc lời nói liên tục có thể không tạo silence boundary; vẫn phải phát mock final định kỳ.
        const chunkDurationMs = (pcmData.length / 2 / 16000) * 1000;
        const speechDurationMs = timestampMs - speechStartMs + chunkDurationMs;
        if (
          hasActiveSpeech &&
          vadResult.isVoice &&
          speechDurationMs >= MockSTTProvider.MAX_SPEECH_SEGMENT_MS
        ) {
          emitFinalSentence(speechStartMs, timestampMs + chunkDurationMs, 'max_duration');
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
