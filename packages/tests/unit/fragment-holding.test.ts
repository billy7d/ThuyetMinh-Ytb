import { describe, expect, it } from 'vitest';
import {
  RealtimePipeline,
  STTProvider,
  STTStreamCallbacks,
  STTStreamSession,
  TTSProvider,
  TTSRequest,
  TTSResponse,
  TranslationEngine,
  TranslationProvider,
  generateSyntheticWavBuffer,
  joinFragments
} from '@vietdub/backend';
import { ServerMessage } from '@vietdub/shared';

const echo: TranslationProvider = {
  name: 'EchoFixture',
  async translate(request) {
    return { translatedText: `Dịch: ${request.sourceText}` };
  }
};

describe('ghép mảnh câu bị cắt giữa chừng', () => {
  it('mảnh bị cắt vì quá dài bỏ dấu chấm giả và viết thường chữ đầu đoạn sau', () => {
    expect(joinFragments('The second thing I want you to notice is that every.', true, 'Time we simplified the architecture.'))
      .toBe('The second thing I want you to notice is that every Time we simplified the architecture.');
    expect(joinFragments('Even a tiny delay can add up.', true, 'We decided to focus.')).toBe('Even a tiny delay can add up we decided to focus.');
    expect(joinFragments('It was late.', true, 'I left early.')).toBe('It was late I left early.');
  });

  it('mảnh không có dấu cuối thì thêm dấu phẩy, trừ khi đang dừng ở từ nối', () => {
    expect(joinFragments('If you have a system that processes millions of requests every day', false, 'Even a tiny delay can hurt.'))
      .toBe('If you have a system that processes millions of requests every day, even a tiny delay can hurt.');
    expect(joinFragments('We stopped the project because', false, 'it was too expensive.')).toBe('We stopped the project because it was too expensive.');
  });
});

describe('TranslationEngine giữ mảnh dở', () => {
  it('đoạn bị cắt giữa chừng không bao giờ dịch riêng dù có dấu chấm cuối, mà chờ phần nối tiếp', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false });
    const first = await engine.translate('when we started building this system a few years ago.', 0, 3_000, { endedMidSpeech: true });
    expect(first.buffered).toBe(true);
    const second = await engine.translate('We assumed the hardest part would be the data.', 3_100, 5_500);
    expect(second.buffered).toBe(false);
    expect(second.sourceText).toBe('when we started building this system a few years ago we assumed the hardest part would be the data.');
    expect(second.startMs).toBe(0);
  });

  it('đoạn dài đủ nhưng không có dấu câu cuối không còn bị dịch riêng (mặc định chờ phần nối tiếp)', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false });
    const first = await engine.translate('So instead of trying to fix everything at once', 0, 2_500);
    expect(first.buffered).toBe(true);
    const second = await engine.translate('We decided to focus on three parts.', 2_800, 5_000);
    expect(second.sourceText).toBe('So instead of trying to fix everything at once, we decided to focus on three parts.');
  });

  it('câu kết thúc ở "that every" là câu còn dở', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false });
    const first = await engine.translate('The second thing I want you to notice is that every', 0, 2_000);
    expect(first.buffered).toBe(true);
  });

  it('câu trọn vẹn kết thúc bình thường vẫn dịch ngay, không chờ', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false });
    const result = await engine.translate('We measured the results after every single change.', 0, 2_000);
    expect(result.buffered).toBe(false);
  });

  it('hết giới hạn thời gian giữ thì vẫn buộc dịch để không treo', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false, maxPendingDurationMs: 6_000 });
    const first = await engine.translate('We started this project years ago and', 0, 3_500, { endedMidSpeech: true });
    expect(first.buffered).toBe(true);
    const second = await engine.translate('then we kept going for a very long time.', 3_600, 7_000, { endedMidSpeech: true });
    expect(second.buffered).toBe(false);
  });
});

class ManualSTT implements STTProvider {
  readonly name = 'ManualSTT';
  callbacks: STTStreamCallbacks | null = null;
  createStream(_sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    this.callbacks = callbacks;
    return { sendAudioChunk: () => {}, endStream: () => {}, abort: () => {} };
  }
  final(text: string, startMs: number, endMs: number, endedMidSpeech = false): void {
    this.callbacks?.onFinal({ segmentId: `${startMs}`, text, startMs, endMs, isFinal: true, confidence: 1, ...(endedMidSpeech ? { endedMidSpeech } : {}) });
  }
}

const quietTts: TTSProvider = {
  name: 'QuietTTS',
  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    return {
      segmentId: request.segmentId,
      generation: request.generation,
      audioBase64: generateSyntheticWavBuffer(0.1, 24_000).toString('base64'),
      mimeType: 'audio/wav',
      durationMs: 100,
      sampleRate: 24_000,
      channels: 1,
      cancelled: false
    };
  },
  cancelGeneration() {}
};

describe('pipeline: dịch một câu liền mạch thay vì hai nửa', () => {
  it('đoạn bị cắt giữa chừng được dịch cùng phần nối tiếp, chỉ một bản dịch và một giọng đọc', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_hold', 'dubbing_and_subtitle', stt, new TranslationEngine(echo, undefined, { validateVietnamese: false }), quietTts,
      { sendMessage: message => messages.push(message) }, {}, { pendingFlushMs: 500 }
    );
    pipeline.start();
    stt.final('The second thing I want you to notice is that every.', 0, 3_000, true);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(messages.some(message => message.type === 'TRANSLATION_READY')).toBe(false);
    stt.final('time we simplified the architecture.', 3_100, 5_000);
    await new Promise(resolve => setTimeout(resolve, 400));
    const ready = messages.filter((message): message is Extract<ServerMessage, { type: 'TRANSLATION_READY' }> => message.type === 'TRANSLATION_READY');
    expect(ready).toHaveLength(1);
    expect(ready[0].sourceText).toBe('The second thing I want you to notice is that every time we simplified the architecture.');
    pipeline.stop();
  });

  it('không có phần nối tiếp thì sau thời gian giữ mảnh vẫn được dịch', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_hold2', 'subtitle_only', stt, new TranslationEngine(echo, undefined, { validateVietnamese: false }), quietTts,
      { sendMessage: message => messages.push(message) }, {}, { pendingFlushMs: 150 }
    );
    pipeline.start();
    stt.final('Thank you all so much for coming tonight.', 0, 3_000, true);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(messages.filter(message => message.type === 'TRANSLATION_READY')).toHaveLength(1);
    pipeline.stop();
  });
});
