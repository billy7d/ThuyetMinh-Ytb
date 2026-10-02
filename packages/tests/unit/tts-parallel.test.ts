import { describe, expect, it } from 'vitest';
import {
  LocalWorkerClientLike,
  LocalWorkerPool,
  RealtimePipeline,
  STTProvider,
  STTStreamCallbacks,
  STTStreamSession,
  TTSProvider,
  TTSRequest,
  TTSResponse,
  TranslationEngine,
  TranslationProvider,
  generateSyntheticWavBuffer
} from '@vietdub/backend';
import { ServerMessage } from '@vietdub/shared';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Điều kiện kiểm thử không đạt trong thời hạn.');
    await wait(5);
  }
}

class RecordingWorker implements LocalWorkerClientLike {
  readonly requests: Record<string, unknown>[] = [];
  closed = false;
  constructor(private readonly delayMs = 0) {}
  async request<T>(payload: Record<string, unknown>): Promise<T> {
    this.requests.push(payload);
    if (this.delayMs) await wait(this.delayMs);
    return { ok: true } as T;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('nhóm tiến trình worker (LocalWorkerPool)', () => {
  it('chia request cho tiến trình đang rảnh, gửi cancel cho tất cả và đóng tất cả', async () => {
    const a = new RecordingWorker(40);
    const b = new RecordingWorker(40);
    const pool = new LocalWorkerPool([a, b]);
    await Promise.all([1, 2, 3, 4].map(n => pool.request({ op: 'synthesize', n })));
    expect(a.requests).toHaveLength(2);
    expect(b.requests).toHaveLength(2);
    await pool.request({ op: 'cancel', beforeGeneration: 2 });
    expect(a.requests.at(-1)).toMatchObject({ op: 'cancel' });
    expect(b.requests.at(-1)).toMatchObject({ op: 'cancel' });
    await pool.close();
    expect(a.closed && b.closed).toBe(true);
  });

  it('một tiến trình bận thì request mới đi sang tiến trình còn lại', async () => {
    const slow = new RecordingWorker(200);
    const fast = new RecordingWorker(0);
    const pool = new LocalWorkerPool([slow, fast]);
    const first = pool.request({ op: 'synthesize', n: 1 });
    for (const n of [2, 3, 4]) await pool.request({ op: 'synthesize', n });
    expect(slow.requests).toHaveLength(1);
    expect(fast.requests).toHaveLength(3);
    await first;
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

/** Câu đầu tổng hợp chậm hơn câu sau để ép câu sau xong trước. */
class StaggeredTTS implements TTSProvider {
  readonly name = 'StaggeredTTS';
  active = 0;
  maxActive = 0;
  constructor(readonly concurrency: number, private readonly delays: number[]) {}
  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const index = Number(request.text.match(/\d+/)?.[0] ?? 0);
    await wait(this.delays[index] ?? 10);
    this.active--;
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
  }
  cancelGeneration(): void {}
}

const numbered: TranslationProvider = {
  name: 'NumberedTranslation',
  async translate(request) {
    return { translatedText: `Câu số ${Math.round(request.startMs / 1000)}.` };
  }
};

async function run(concurrency: number): Promise<{ tts: StaggeredTTS; chunks: string[] }> {
  const messages: ServerMessage[] = [];
  const stt = new ManualSTT();
  const tts = new StaggeredTTS(concurrency, [150, 10, 10]);
  const pipeline = new RealtimePipeline(
    `pipe_par_${concurrency}`, 'dubbing_and_subtitle', stt, new TranslationEngine(numbered), tts,
    { sendMessage: message => messages.push(message) }
  );
  pipeline.start();
  stt.final('First sentence here.', 0, 1_000);
  stt.final('Second sentence here.', 1_000, 2_000);
  stt.final('Third sentence here.', 2_000, 3_000);
  await waitUntil(() => messages.filter(message => message.type === 'TTS_CHUNK').length === 3);
  pipeline.stop();
  const chunks = messages
    .filter(message => message.type === 'TTS_CHUNK' || message.type === 'SUBTITLE_EVENT')
    .map(message => `${message.type}:${(message as { segmentId: string }).segmentId}`);
  return { tts, chunks };
}

describe('tổng hợp thuyết minh song song nhưng giữ thứ tự', () => {
  it('concurrency 1: tuần tự, không bao giờ chạy hai câu cùng lúc', async () => {
    const { tts } = await run(1);
    expect(tts.maxActive).toBe(1);
  });

  it('concurrency 2: chạy hai câu cùng lúc, câu xong sớm vẫn chờ câu trước rồi mới phát; phụ đề đi ngay trước giọng đọc', async () => {
    const { tts, chunks } = await run(2);
    expect(tts.maxActive).toBe(2);
    const ttsOrder = chunks.filter(entry => entry.startsWith('TTS_CHUNK')).map(entry => entry.split(':')[1]);
    expect(ttsOrder).toEqual([...ttsOrder].sort());
    expect(chunks.length).toBe(6);
    for (let index = 0; index < chunks.length; index += 2) {
      expect(chunks[index].startsWith('SUBTITLE_EVENT')).toBe(true);
      expect(chunks[index + 1].startsWith('TTS_CHUNK')).toBe(true);
      expect(chunks[index].split(':')[1]).toBe(chunks[index + 1].split(':')[1]);
    }
  });
});
