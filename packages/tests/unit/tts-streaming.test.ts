import { describe, expect, it } from 'vitest';
import {
  JsonLineWorkerClient,
  LocalVietnameseTTSProvider,
  LocalWorkerClientLike,
  RealtimePipeline,
  STTProvider,
  STTStreamCallbacks,
  STTStreamSession,
  TTSProvider,
  TTSRequest,
  TTSResponse,
  TTSStreamPart,
  TranslationEngine,
  TranslationProvider
} from '@vietdub/backend';
import { ServerMessage, TTSChunkMessage } from '@vietdub/shared';
import { StreamingTimeStretcher } from '../../extension/src/audio/streaming-stretch.js';
import { timeStretchMono } from '../../extension/src/audio/time-stretch.js';
import { TtsStreamReceiver, decodePcm16 } from '../../extension/src/audio/tts-stream-receiver.js';

const SAMPLE_RATE = 48_000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function voiced(seconds: number, f0 = 140): Float32Array {
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < data.length; index += 1) {
    const t = index / SAMPLE_RATE;
    let value = 0;
    for (let harmonic = 1; harmonic <= 6; harmonic += 1) value += Math.sin(2 * Math.PI * f0 * harmonic * t) / harmonic;
    data[index] = 0.3 * value * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
  }
  return data;
}

function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((value, index) => {
    const int = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    bytes[index * 2] = int & 0xff;
    bytes[index * 2 + 1] = (int >> 8) & 0xff;
  });
  return Buffer.from(bytes).toString('base64');
}

describe('co giãn giữ cao độ theo luồng', () => {
  it('đầu ra giống hệt co giãn cả câu dù chia đoạn nhỏ hay lớn (không có lỗ ở mối nối)', () => {
    const input = voiced(3);
    const whole = timeStretchMono(input, SAMPLE_RATE, 1.3, 10_000);
    for (const pieceSize of [4_000, 24_000, 60_000]) {
      const stretcher = new StreamingTimeStretcher(SAMPLE_RATE, 1.3);
      const pieces: Float32Array[] = [];
      for (let offset = 0; offset < input.length; offset += pieceSize) pieces.push(stretcher.push(input.subarray(offset, offset + pieceSize)));
      pieces.push(stretcher.flush());
      const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
      let cursor = 0;
      for (const piece of pieces) {
        joined.set(piece, cursor);
        cursor += piece.length;
      }
      expect(Math.abs(joined.length - whole.length)).toBeLessThanOrEqual(1);
      const common = Math.min(joined.length, whole.length) - 2_000;
      let maxDiff = 0;
      for (let index = 0; index < common; index += 1) maxDiff = Math.max(maxDiff, Math.abs(joined[index] - whole[index]));
      expect(maxDiff).toBeLessThan(1e-4);
    }
  });

  it('không trả gì khi chưa đủ dữ liệu cho một khung, và đoạn quá ngắn được trả nguyên bản khi xả', () => {
    const stretcher = new StreamingTimeStretcher(SAMPLE_RATE, 1.3);
    expect(stretcher.push(new Float32Array(100)).length).toBeLessThanOrEqual(0);
    const tiny = new Float32Array(100).fill(0.1);
    const short = new StreamingTimeStretcher(SAMPLE_RATE, 1.3);
    short.push(tiny);
    expect(short.flush()).toEqual(tiny);
    expect(new StreamingTimeStretcher(SAMPLE_RATE, 1.3).flush().length).toBe(0);
  });

  it('rút ngắn đúng tỉ lệ', () => {
    const input = voiced(2);
    const stretcher = new StreamingTimeStretcher(SAMPLE_RATE, 1.25);
    const pieces = [stretcher.push(input.subarray(0, 30_000)), stretcher.push(input.subarray(30_000)), stretcher.flush()];
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    expect(total / input.length).toBeCloseTo(1 / 1.25, 2);
  });
});

class FakeMixer {
  backlogMs = 0;
  rate = 1;
  scheduled: Array<{ durationMs: number }> = [];
  private listener: (() => void) | null = null;
  chosen: Array<{ estimatedMs: number; sourceMs: number | undefined }> = [];
  onTtsStopped(listener: () => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  stop(): void { this.listener?.(); }
  isTtsBacklogTooLong(): boolean { return this.backlogMs > 3_500; }
  getTTSBacklogMs(): number { return this.backlogMs; }
  chooseTtsRate(estimatedMs: number, sourceMs: number | undefined): number {
    this.chosen.push({ estimatedMs, sourceMs });
    return this.rate;
  }
  scheduleStreamPiece(buffer: AudioBuffer) {
    const durationMs = Math.round(buffer.duration * 1000);
    this.scheduled.push({ durationMs });
    return { source: {} as AudioBufferSourceNode, delayMs: 0, durationMs };
  }
}

function fakeBufferContext() {
  return {
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { duration: length / sampleRate, length, sampleRate, numberOfChannels: 1, getChannelData: () => data, copyToChannel: (source: Float32Array) => data.set(source) } as unknown as AudioBuffer;
    }
  };
}

function chunk(fields: Partial<TTSChunkMessage>): TTSChunkMessage {
  return {
    type: 'TTS_CHUNK', sessionId: 's', timestamp: 0, segmentId: 'seg', audioBase64: '', mimeType: 'audio/pcm', sampleRate: SAMPLE_RATE, channels: 1,
    durationMs: 0, generation: 1, translatedText: 'x', startMs: 0, endMs: 6_000, ...fields
  };
}

function makeReceiver(mixer: FakeMixer) {
  const subtitle = { scheduled: [] as unknown[][], dropped: [] as string[] };
  const sync = {
    ttsScheduled: (...args: unknown[]) => subtitle.scheduled.push(args),
    ttsDropped: (id: string) => subtitle.dropped.push(id)
  };
  const receiver = new TtsStreamReceiver({
    audioCtx: fakeBufferContext(),
    mixer: mixer as never,
    getSubtitleSync: () => sync as never,
    diagScope: 'test_tts'
  });
  return { receiver, subtitle };
}

describe('TtsStreamReceiver', () => {
  it('giải mã PCM 16-bit đúng', () => {
    const original = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const decoded = decodePcm16(pcm16Base64(original));
    original.forEach((value, index) => expect(decoded[index]).toBeCloseTo(value, 3));
  });

  it('tốc độ 1.0: xếp từng đoạn phát liền nhau, phụ đề báo một lần với tổng thời lượng ước tính, bản tin cuối dọn trạng thái', () => {
    const mixer = new FakeMixer();
    const { receiver, subtitle } = makeReceiver(mixer);
    receiver.handle(chunk({ partIndex: 0, audioBase64: pcm16Base64(voiced(0.5)), durationMs: 500, totalDurationMs: 4_000 }));
    receiver.handle(chunk({ partIndex: 1, audioBase64: pcm16Base64(voiced(1.2)), durationMs: 1_200 }));
    receiver.handle(chunk({ partIndex: 2, partFinal: true }));
    expect(mixer.scheduled.map(piece => piece.durationMs)).toEqual([500, 1_200]);
    expect(subtitle.scheduled).toHaveLength(1);
    expect(subtitle.scheduled[0].slice(1)).toEqual([0, 500, 4_000]);
    expect(mixer.chosen).toEqual([{ estimatedMs: 4_000, sourceMs: 6_000 }]);
  });

  it('tăng tốc: cả câu đi qua một bộ co giãn, tổng thời lượng phát ≈ tổng đầu vào / tốc độ', () => {
    const mixer = new FakeMixer();
    mixer.rate = 1.3;
    const { receiver } = makeReceiver(mixer);
    const total = voiced(3);
    const cuts = [0, 24_000, 72_000, total.length];
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const part = total.subarray(cuts[index], cuts[index + 1]);
      receiver.handle(chunk({ partIndex: index, audioBase64: pcm16Base64(part), durationMs: (part.length / SAMPLE_RATE) * 1000, totalDurationMs: 3_000 }));
    }
    receiver.handle(chunk({ partIndex: 3, partFinal: true }));
    const played = mixer.scheduled.reduce((sum, piece) => sum + piece.durationMs, 0);
    expect(played / 3_000).toBeCloseTo(1 / 1.3, 1);
  });

  it('hàng chờ quá dài: bỏ cả câu, phụ đề hiện ngay, các đoạn sau bị bỏ qua', () => {
    const mixer = new FakeMixer();
    mixer.backlogMs = 5_000;
    const { receiver, subtitle } = makeReceiver(mixer);
    receiver.handle(chunk({ partIndex: 0, audioBase64: pcm16Base64(voiced(0.5)), durationMs: 500, totalDurationMs: 4_000 }));
    receiver.handle(chunk({ partIndex: 1, audioBase64: pcm16Base64(voiced(0.5)), durationMs: 500 }));
    receiver.handle(chunk({ partIndex: 2, partFinal: true }));
    expect(mixer.scheduled).toHaveLength(0);
    expect(subtitle.dropped).toEqual(['seg']);
  });

  it('tua/tạm dừng (mixer.stopTTS) làm bộ nhận quên câu đang nhận dở', () => {
    const mixer = new FakeMixer();
    const { receiver } = makeReceiver(mixer);
    receiver.handle(chunk({ partIndex: 0, audioBase64: pcm16Base64(voiced(0.5)), durationMs: 500, totalDurationMs: 4_000 }));
    mixer.stop();
    // Đoạn tiếp theo của câu cũ không còn đoạn đầu: bản tin cuối rời rạc bị bỏ qua, không ném lỗi.
    receiver.handle(chunk({ partIndex: 1, partFinal: true }));
    expect(mixer.scheduled).toHaveLength(1);
  });

  it('đoạn phát hết ngắn tới mức chưa từng có tiếng thì hiện phụ đề ngay', () => {
    const mixer = new FakeMixer();
    const { receiver, subtitle } = makeReceiver(mixer);
    receiver.handle(chunk({ partIndex: 0, audioBase64: '', durationMs: 0, totalDurationMs: 400 }));
    receiver.handle(chunk({ partIndex: 1, partFinal: true }));
    expect(subtitle.dropped).toEqual(['seg']);
  });
});

describe('worker client: kết quả từng phần', () => {
  it('chuyển các tin partial cho onPartial rồi mới trả kết quả cuối', async () => {
    const script = [
      "const readline=require('node:readline');",
      "console.log(JSON.stringify({event:'ready'}));",
      "const rl=readline.createInterface({input:process.stdin});",
      "rl.on('line', line => { const msg=JSON.parse(line);",
      "  for (let i=0;i<3;i++) console.log(JSON.stringify({id:msg.id,partial:true,result:{index:i}}));",
      "  console.log(JSON.stringify({id:msg.id,ok:true,result:{done:true}})); });"
    ].join('');
    const client = new JsonLineWorkerClient({
      name: 'partial-worker',
      command: { command: process.execPath, args: ['-e', script] },
      startupTimeoutMs: 3_000,
      requestTimeoutMs: 3_000
    });
    try {
      const parts: unknown[] = [];
      const result = await client.request({ op: 'synthesize', stream: true }, { onPartial: value => parts.push(value) });
      expect(parts).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
      expect(result).toEqual({ done: true });
    } finally {
      await client.close();
    }
  });
});

describe('LocalVietnameseTTSProvider.synthesizeStream', () => {
  const pcm = pcm16Base64(voiced(0.3));
  const make = (): { worker: LocalWorkerClientLike; requests: Record<string, unknown>[] } => {
    const requests: Record<string, unknown>[] = [];
    const worker: LocalWorkerClientLike = {
      async request<T>(payload: Record<string, unknown>, options?: { onPartial?: (value: unknown) => void }): Promise<T> {
        requests.push(payload);
        if (payload.op === 'cancel') return {} as T;
        for (let index = 0; index < 3; index += 1) {
          options?.onPartial?.({ audioBase64: pcm, mimeType: 'audio/pcm', sampleRate: SAMPLE_RATE, channels: 1, durationMs: 300, index });
          await wait(5);
        }
        return { durationMs: 900 } as T;
      },
      async close() {}
    };
    return { worker, requests };
  };
  const request: TTSRequest = { segmentId: 'a', text: 'Xin chào.', generation: 1, startMs: 0, endMs: 1_000 };

  it('gửi yêu cầu stream:true và chuyển từng đoạn PCM theo thứ tự', async () => {
    const { worker, requests } = make();
    const provider = new LocalVietnameseTTSProvider(worker, { modelPath: '/tts' });
    const parts: TTSStreamPart[] = [];
    const result = await provider.synthesizeStream(request, part => parts.push(part));
    expect(requests[0]).toMatchObject({ op: 'synthesize', stream: true, generation: 1 });
    expect(parts.map(part => part.index)).toEqual([0, 1, 2]);
    expect(parts.every(part => part.mimeType === 'audio/pcm' && part.sampleRate === SAMPLE_RATE)).toBe(true);
    expect(result).toEqual({ cancelled: false, durationMs: 900 });
  });

  it('generation đã hủy: không gửi gì, và đoạn đến sau khi hủy bị bỏ', async () => {
    const { worker, requests } = make();
    const provider = new LocalVietnameseTTSProvider(worker, { modelPath: '/tts' });
    provider.cancelGeneration(1);
    const cancelled = await provider.synthesizeStream(request, () => { throw new Error('không được gọi'); });
    expect(cancelled).toEqual({ cancelled: true, durationMs: 0 });
    expect(requests.filter(item => item.op === 'synthesize')).toHaveLength(0);
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

const vi: TranslationProvider = { name: 'Vi', async translate(request) { return { translatedText: `Dịch ${request.startMs}: một hai ba bốn năm sáu bảy tám chín mười.` }; } };

function streamingTts(log: string[], failAfter?: number): TTSProvider {
  return {
    name: 'StreamTTS',
    async synthesize(request: TTSRequest): Promise<TTSResponse> {
      throw new Error(`synthesize không được dùng khi có luồng: ${request.segmentId}`);
    },
    async synthesizeStream(request, onPart) {
      log.push(`start ${request.segmentId}`);
      for (let index = 0; index < 3; index += 1) {
        await wait(15);
        if (failAfter !== undefined && index === failAfter) throw new Error('worker lỗi');
        onPart({ audioBase64: pcm16Base64(voiced(0.2)), mimeType: 'audio/pcm', sampleRate: SAMPLE_RATE, channels: 1, durationMs: 200, index });
      }
      return { cancelled: false, durationMs: 600 };
    },
    cancelGeneration() {}
  };
}

function summarize(messages: ServerMessage[]): string[] {
  return messages
    .filter(message => message.type === 'SUBTITLE_EVENT' || message.type === 'TTS_CHUNK')
    .map(message => {
      if (message.type === 'SUBTITLE_EVENT') return `sub:${message.segmentId}`;
      const chunk = message as TTSChunkMessage;
      return `tts:${chunk.segmentId}:${chunk.partFinal ? 'final' : chunk.partIndex}`;
    });
}

describe('pipeline: giọng đọc dạng luồng', () => {
  it('phụ đề trước đoạn đầu (kèm tổng thời lượng ước tính), các đoạn theo thứ tự, bản tin cuối partFinal; hai câu không xen kẽ', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const log: string[] = [];
    const pipeline = new RealtimePipeline(
      'pipe_stream', 'dubbing_and_subtitle', stt, new TranslationEngine(vi, undefined, { validateVietnamese: false }), streamingTts(log),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    stt.final('First sentence is right here.', 0, 2_000);
    stt.final('Second sentence is right here.', 2_100, 4_000);
    await wait(500);
    const summary = summarize(messages);
    expect(summary).toEqual([
      'sub:seg_1', 'tts:seg_1:0', 'tts:seg_1:1', 'tts:seg_1:2', 'tts:seg_1:final',
      'sub:seg_2', 'tts:seg_2:0', 'tts:seg_2:1', 'tts:seg_2:2', 'tts:seg_2:final'
    ]);
    const first = messages.find((message): message is TTSChunkMessage => message.type === 'TTS_CHUNK')!;
    expect(first.mimeType).toBe('audio/pcm');
    expect(first.totalDurationMs).toBeGreaterThan(1_000);
    const subtitle = messages.find(message => message.type === 'SUBTITLE_EVENT') as Extract<ServerMessage, { type: 'SUBTITLE_EVENT' }>;
    expect(subtitle.ttsDurationMs).toBe(first.totalDurationMs);
    pipeline.stop();
  });

  it('worker lỗi giữa chừng: vẫn gửi bản tin cuối cho đoạn đã phát và báo lỗi không nghiêm trọng', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_stream_err', 'dubbing_and_subtitle', stt, new TranslationEngine(vi, undefined, { validateVietnamese: false }), streamingTts([], 2),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    stt.final('First sentence is right here.', 0, 2_000);
    await wait(300);
    expect(summarize(messages)).toEqual(['sub:seg_1', 'tts:seg_1:0', 'tts:seg_1:1', 'tts:seg_1:final']);
    expect(messages.some(message => message.type === 'ERROR' && message.code === 'TTS_ERROR' && !message.fatal)).toBe(true);
    pipeline.stop();
  });

  it('streamTtsAudio=false dùng synthesize() như trước', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const tts: TTSProvider = {
      ...streamingTts([]),
      async synthesize(request: TTSRequest): Promise<TTSResponse> {
        return { segmentId: request.segmentId, generation: request.generation, audioBase64: 'AAAA', mimeType: 'audio/wav', durationMs: 100, sampleRate: 24_000, channels: 1, cancelled: false };
      }
    };
    const pipeline = new RealtimePipeline(
      'pipe_nostream', 'dubbing_and_subtitle', stt, new TranslationEngine(vi, undefined, { validateVietnamese: false }), tts,
      { sendMessage: message => messages.push(message) }, {}, { streamTtsAudio: false }
    );
    pipeline.start();
    stt.final('First sentence is right here.', 0, 2_000);
    await wait(250);
    expect(summarize(messages)).toEqual(['sub:seg_1', 'tts:seg_1:undefined']);
    pipeline.stop();
  });
});
