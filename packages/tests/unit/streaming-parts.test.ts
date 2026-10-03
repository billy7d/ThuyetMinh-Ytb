import { describe, expect, it } from 'vitest';
import {
  RealtimePipeline,
  SentenceCompletionGuard,
  STTProvider,
  STTStreamCallbacks,
  STTStreamSession,
  TTSProvider,
  TTSRequest,
  TTSResponse,
  TranslationEngine,
  TranslationProvider,
  generateSyntheticWavBuffer,
  splitForStreaming
} from '@vietdub/backend';
import { ServerMessage } from '@vietdub/shared';
import { SyncedSubtitleRelease, TtsSubtitleSync, ttsSlotMs, ttsTotalDisplayMs } from '../../extension/src/sync/tts-subtitle-sync.js';

const echo: TranslationProvider = {
  name: 'EchoFixture',
  async translate(request) {
    return { translatedText: `Dịch: ${request.sourceText}` };
  }
};

describe('đoạn bị cắt nhưng tự đủ ý thì dịch ngay', () => {
  it('câu trọn vẹn có dấu chấm bị cắt vì quá dài không phải chờ phần sau', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false });
    const result = await engine.translate('And we measured the results after every single change.', 0, 3_400, { endedMidSpeech: true });
    expect(result.buffered).toBe(false);
  });

  it('mệnh đề phụ, đoạn chữ thường, dừng ở từ nối hoặc quá ngắn vẫn chờ phần nối tiếp', () => {
    const guard = new SentenceCompletionGuard();
    expect(guard.isSelfContained('We measured the results after every change.')).toBe(true);
    expect(guard.isSelfContained('when we started building this system a few years ago.')).toBe(false);
    expect(guard.isSelfContained('If you have a system that processes millions of requests.')).toBe(false);
    expect(guard.isSelfContained('time we simplified the architecture.')).toBe(false);
    expect(guard.isSelfContained('The second thing I want you to notice is that every.')).toBe(false);
    expect(guard.isSelfContained('Thank you.')).toBe(false);
    expect(guard.isSelfContained('We measured the results after every change')).toBe(false);
  });

  it('mệnh đề phụ bị cắt vẫn được giữ rồi ghép với phần sau', async () => {
    const engine = new TranslationEngine(echo, undefined, { validateVietnamese: false });
    const first = await engine.translate('when we started building this system a few years ago.', 0, 3_000, { endedMidSpeech: true });
    expect(first.buffered).toBe(true);
    const second = await engine.translate('We assumed the hardest part would be the data.', 3_100, 5_500);
    expect(second.sourceText).toBe('when we started building this system a few years ago we assumed the hardest part would be the data.');
  });
});

describe('chia câu dài thành các vế để đọc sớm', () => {
  it('chỉ cắt ở dấu phẩy, vế đầu ngắn hơn, mỗi vế đủ dài; câu ngắn đọc nguyên', () => {
    expect(splitForStreaming('Câu ngắn thôi, không cần cắt.')).toEqual(['Câu ngắn thôi, không cần cắt.']);
    const text = 'Nếu bạn có một hệ thống xử lý hàng triệu yêu cầu mỗi ngày, thậm chí một sự chậm trễ nhỏ trong một thành phần cũng có thể gây ra vấn đề nghiêm trọng.';
    const parts = splitForStreaming(text);
    expect(parts).toHaveLength(2);
    expect(parts[0].endsWith(',')).toBe(true);
    expect(parts.join(' ')).toBe(text);
    expect(parts.every(part => part.length >= 28)).toBe(true);
  });

  it('không có dấu phẩy thì không cắt (giữ ngắt nghỉ tự nhiên), số thập phân không bị cắt', () => {
    const noComma = 'Chúng tôi quyết định tập trung vào ba phần của hệ thống gây ra hầu hết các khiếu nại của khách hàng trong năm qua';
    expect(splitForStreaming(noComma)).toEqual([noComma]);
    const decimal = 'Tăng trưởng đạt 2,5 phần trăm trong quý vừa rồi và chúng tôi kỳ vọng con số này sẽ còn tăng thêm trong quý tới nữa';
    expect(splitForStreaming(decimal)).toEqual([decimal]);
  });

  it('câu rất dài được chia tối đa 3 vế', () => {
    const text = 'Đầu tiên chúng tôi đo lường mọi thứ cẩn thận, sau đó chúng tôi so sánh kết quả với bản cũ, rồi chúng tôi quyết định giữ lại những thay đổi có ích, và cuối cùng chúng tôi viết báo cáo chi tiết cho cả nhóm.';
    const parts = splitForStreaming(text);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.join(' ')).toBe(text);
  });
});

class ManualSTT implements STTProvider {
  readonly name = 'ManualSTT';
  callbacks: STTStreamCallbacks | null = null;
  createStream(_sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    this.callbacks = callbacks;
    return { sendAudioChunk: () => {}, endStream: () => {}, abort: () => {} };
  }
  final(text: string, startMs: number, endMs: number): void {
    this.callbacks?.onFinal({ segmentId: `${startMs}`, text, startMs, endMs, isFinal: true, confidence: 1 });
  }
}

const LONG_VI = 'Nếu bạn có một hệ thống xử lý hàng triệu yêu cầu mỗi ngày, thậm chí một sự chậm trễ nhỏ trong một thành phần cũng có thể gây ra vấn đề nghiêm trọng.';
const longVi: TranslationProvider = { name: 'LongVi', async translate() { return { translatedText: LONG_VI }; } };

function partsTts(spoken: string[]): TTSProvider {
  return {
    name: 'PartsTTS',
    async synthesize(request: TTSRequest): Promise<TTSResponse> {
      spoken.push(request.text);
      return {
        segmentId: request.segmentId,
        generation: request.generation,
        audioBase64: generateSyntheticWavBuffer(0.1, 24_000).toString('base64'),
        mimeType: 'audio/wav',
        durationMs: request.text.length * 60,
        sampleRate: 24_000,
        channels: 1,
        cancelled: false
      };
    },
    cancelGeneration() {}
  };
}

describe('pipeline: giọng đọc từng vế', () => {
  it('phụ đề đi trước vế đầu một lần với tổng thời lượng; các vế có chỉ số và tỉ lệ khung', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const spoken: string[] = [];
    const pipeline = new RealtimePipeline(
      'pipe_parts', 'dubbing_and_subtitle', stt, new TranslationEngine(longVi, undefined, { validateVietnamese: false }), partsTts(spoken),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    stt.final('If you have a system that processes millions of requests every day, even a tiny delay can cause serious problems.', 0, 4_000);
    await new Promise(resolve => setTimeout(resolve, 400));
    const relevant = messages.filter(message => message.type === 'SUBTITLE_EVENT' || message.type === 'TTS_CHUNK');
    expect(relevant.map(message => message.type)).toEqual(['SUBTITLE_EVENT', 'TTS_CHUNK', 'TTS_CHUNK']);
    const [subtitle, first, second] = relevant as [
      Extract<ServerMessage, { type: 'SUBTITLE_EVENT' }>,
      Extract<ServerMessage, { type: 'TTS_CHUNK' }>,
      Extract<ServerMessage, { type: 'TTS_CHUNK' }>
    ];
    expect(spoken).toHaveLength(2);
    expect([first.partIndex, first.partCount, second.partIndex, second.partCount]).toEqual([0, 2, 1, 2]);
    expect(first.totalDurationMs).toBeGreaterThan(first.durationMs);
    expect(second.totalDurationMs).toBeUndefined();
    expect((first.slotShare ?? 0) + (second.slotShare ?? 0)).toBeCloseTo(1, 5);
    expect(subtitle.segmentId).toBe(first.segmentId);
    expect(subtitle.text).toContain(',');
    expect(subtitle.ttsDurationMs).toBe(first.totalDurationMs);
    pipeline.stop();
  });

  it('streamTtsParts=false đọc nguyên câu một đoạn như trước', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_noparts', 'dubbing_and_subtitle', stt, new TranslationEngine(longVi, undefined, { validateVietnamese: false }), partsTts([]),
      { sendMessage: message => messages.push(message) }, {}, { streamTtsParts: false }
    );
    pipeline.start();
    stt.final('If you have a system that processes millions of requests every day, even a tiny delay can cause serious problems.', 0, 4_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    const chunks = messages.filter((message): message is Extract<ServerMessage, { type: 'TTS_CHUNK' }> => message.type === 'TTS_CHUNK');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].partCount).toBeUndefined();
    pipeline.stop();
  });
});

describe('extension: giọng đọc từng vế', () => {
  it('phụ đề hiện theo tổng thời lượng cả câu, không chỉ vế đầu', () => {
    const timers: Array<() => void> = [];
    const clock = { setTimer: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimer: () => {} };
    const released: SyncedSubtitleRelease[] = [];
    const sync = new TtsSubtitleSync(item => released.push(item), clock);
    const message = { type: 'SUBTITLE_EVENT', segmentId: 'a', text: 'x', startMs: 0, endMs: 1, generation: 1, action: 'show', syncWithTts: true } as never;
    sync.offer(message);
    sync.ttsScheduled('a', 0, 3_000, 7_000);
    expect(released[0].ttsDurationMs).toBe(7_000);
    // Vế sau của cùng câu không còn phụ đề đang giữ: không làm gì.
    sync.ttsScheduled('a', 0, 2_000);
    expect(released).toHaveLength(1);
  });

  it('khung thời gian của vế tính theo tỉ lệ; tổng thời lượng nhân tỉ lệ co giãn của vế đầu', () => {
    expect(ttsSlotMs({ startMs: 0, endMs: 6_000, slotShare: 0.4 })).toBe(2_400);
    expect(ttsSlotMs({ startMs: 0, endMs: 6_000 })).toBe(6_000);
    expect(ttsTotalDisplayMs({ durationMs: 4_000, totalDurationMs: 10_000 }, 3_200)).toBe(8_000);
    expect(ttsTotalDisplayMs({ durationMs: 4_000 }, 3_200)).toBeUndefined();
  });
});
