import { describe, it, expect } from 'vitest';
import {
  RealtimePipeline,
  MockSTTProvider,
  TranslationEngine,
  VietnameseTTSEngine
} from '@vietdub/backend';
import { ServerMessage } from '@vietdub/shared';

describe('RealtimePipeline End-to-End Flow', () => {
  it('should process audio chunks and produce transcript, translation, subtitle, and TTS chunks', async () => {
    const receivedMessages: ServerMessage[] = [];
    const sttProvider = new MockSTTProvider(["Let's break it down."]);
    const translationEngine = new TranslationEngine();
    const ttsEngine = new VietnameseTTSEngine();

    const pipeline = new RealtimePipeline(
      'sess_test_1',
      'dubbing_and_subtitle',
      sttProvider,
      translationEngine,
      ttsEngine,
      {
        sendMessage: (msg) => receivedMessages.push(msg)
      }
    );

    pipeline.start();

    // Feed audio chunks: 400ms voice + 700ms silence to trigger VAD
    const voiceChunk = Buffer.alloc(3200);
    for (let i = 0; i < voiceChunk.length; i += 2) {
      voiceChunk.writeInt16LE(Math.floor(Math.sin(i / 10) * 15000), i);
    }
    const silentChunk = Buffer.alloc(3200);

    // 400ms of voice
    pipeline.handleAudioChunk(voiceChunk, 100);
    pipeline.handleAudioChunk(voiceChunk, 200);
    pipeline.handleAudioChunk(voiceChunk, 300);
    pipeline.handleAudioChunk(voiceChunk, 400);

    // Silence
    pipeline.handleAudioChunk(silentChunk, 500);
    pipeline.handleAudioChunk(silentChunk, 700);
    pipeline.handleAudioChunk(silentChunk, 1200);

    // Allow async translation & TTS to finish
    await new Promise((r) => setTimeout(r, 200));

    const msgTypes = receivedMessages.map((m) => m.type);
    expect(msgTypes).toContain('TRANSCRIPT_FINAL');
    expect(msgTypes).toContain('TRANSLATION_READY');
    expect(msgTypes).toContain('SUBTITLE_EVENT');
    expect(msgTypes).toContain('TTS_CHUNK');
    expect(msgTypes).toContain('LATENCY_METRIC');

    const translationMsg = receivedMessages.find((m) => m.type === 'TRANSLATION_READY') as any;
    expect(translationMsg.translatedText).toBe('Chúng ta cùng phân tích kỹ hơn nhé.');

    const ttsMsg = receivedMessages.find((m) => m.type === 'TTS_CHUNK') as any;
    expect(ttsMsg.audioBase64).toBeTruthy();
    expect(ttsMsg.durationMs).toBeGreaterThan(0);

    pipeline.stop();
  });

  it('should suppress TTS in subtitle_only mode while retaining subtitle events', async () => {
    const receivedMessages: ServerMessage[] = [];
    const sttProvider = new MockSTTProvider(["That's not the whole story."]);
    const translationEngine = new TranslationEngine();
    const ttsEngine = new VietnameseTTSEngine();

    const pipeline = new RealtimePipeline(
      'sess_test_2',
      'subtitle_only',
      sttProvider,
      translationEngine,
      ttsEngine,
      {
        sendMessage: (msg) => receivedMessages.push(msg)
      }
    );

    pipeline.start();

    const voiceChunk = Buffer.alloc(3200);
    for (let i = 0; i < voiceChunk.length; i += 2) {
      voiceChunk.writeInt16LE(Math.floor(Math.sin(i / 10) * 15000), i);
    }
    const silentChunk = Buffer.alloc(3200);

    pipeline.handleAudioChunk(voiceChunk, 100);
    pipeline.handleAudioChunk(voiceChunk, 200);
    pipeline.handleAudioChunk(voiceChunk, 300);
    pipeline.handleAudioChunk(voiceChunk, 400);
    pipeline.handleAudioChunk(silentChunk, 1200);

    await new Promise((r) => setTimeout(r, 200));

    const msgTypes = receivedMessages.map((m) => m.type);
    expect(msgTypes).toContain('SUBTITLE_EVENT');
    expect(msgTypes).not.toContain('TTS_CHUNK'); // No TTS in subtitle_only mode

    pipeline.stop();
  });

  it('không phát subtitle trong dubbing_only nhưng vẫn phát TTS', async () => {
    const receivedMessages: ServerMessage[] = [];
    const pipeline = new RealtimePipeline(
      'sess_dubbing_only_mode',
      'dubbing_only',
      new MockSTTProvider(["Let's break it down."]),
      new TranslationEngine(),
      new VietnameseTTSEngine(),
      { sendMessage: (msg) => receivedMessages.push(msg) }
    );

    pipeline.start();
    const voiceChunk = Buffer.alloc(3200);
    for (let index = 0; index < voiceChunk.length; index += 2) {
      voiceChunk.writeInt16LE(Math.floor(Math.sin(index / 10) * 15000), index);
    }
    const silentChunk = Buffer.alloc(3200);

    pipeline.handleAudioChunk(voiceChunk, 100);
    pipeline.handleAudioChunk(voiceChunk, 200);
    pipeline.handleAudioChunk(voiceChunk, 300);
    pipeline.handleAudioChunk(voiceChunk, 400);
    pipeline.handleAudioChunk(silentChunk, 1200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const messageTypes = receivedMessages.map((message) => message.type);
    expect(messageTypes).not.toContain('SUBTITLE_EVENT');
    expect(messageTypes).toContain('TTS_CHUNK');
    pipeline.stop();
  });

  it('should finalize continuous mock speech without waiting for a silence boundary', async () => {
    const receivedMessages: ServerMessage[] = [];
    const pipeline = new RealtimePipeline(
      'sess_continuous_voice',
      'dubbing_and_subtitle',
      new MockSTTProvider(["Let's break it down."]),
      new TranslationEngine(),
      new VietnameseTTSEngine(),
      { sendMessage: (msg) => receivedMessages.push(msg) }
    );

    pipeline.start();
    const voiceChunk = Buffer.alloc(3200);
    for (let i = 0; i < voiceChunk.length; i += 2) {
      voiceChunk.writeInt16LE(Math.floor(Math.sin(i / 10) * 15000), i);
    }

    // Không có silence; đây là tình huống video nói hoặc nhạc liên tục trên browser thật.
    for (let index = 0; index < 8; index += 1) {
      pipeline.handleAudioChunk(voiceChunk, index * 250);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const messageTypes = receivedMessages.map((message) => message.type);
    expect(messageTypes).toContain('TRANSCRIPT_FINAL');
    expect(messageTypes).toContain('TRANSLATION_READY');
    expect(messageTypes).toContain('SUBTITLE_EVENT');
    expect(messageTypes).toContain('TTS_CHUNK');
    pipeline.stop();
  });
});
