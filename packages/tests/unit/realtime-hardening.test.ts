import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeterministicTranslationProvider,
  JsonLineWorkerClient,
  LocalStreamingSTTProvider,
  LocalVietnameseTTSProvider,
  LocalWorkerClientLike,
  RealtimePipeline,
  STTProvider,
  STTStreamCallbacks,
  STTStreamError,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Worker giả điều khiển được: mỗi request audio_chunk chờ tới khi test cho phép trả lời. */
class ControlledWorker implements LocalWorkerClientLike {
  readonly requests: Record<string, unknown>[] = [];
  readonly gates: Array<ReturnType<typeof deferred<unknown>>> = [];
  failAudioWith: string | null = null;

  async request<T>(payload: Record<string, unknown>): Promise<T> {
    this.requests.push(payload);
    if (payload.op === 'audio_chunk') {
      if (this.failAudioWith) throw new Error(this.failAudioWith);
      const gate = deferred<unknown>();
      this.gates.push(gate);
      return gate.promise as Promise<T>;
    }
    return { events: [] } as T;
  }

  async close(): Promise<void> {}
}

function pcm(ms: number): Buffer {
  return Buffer.alloc(Math.round((ms / 1000) * 16_000) * 2);
}

describe('local STT backpressure (P0)', () => {
  it('gom audio khi worker bận thay vì báo lỗi hàng đợi và dừng phiên', async () => {
    const worker = new ControlledWorker();
    const errors: Error[] = [];
    const stream = new LocalStreamingSTTProvider(worker, { modelPath: '/m', maxBufferedMs: 8_000 }).createStream('s1', {
      onInterim: () => {},
      onFinal: () => {},
      onError: error => errors.push(error)
    });
    await wait(0);
    stream.sendAudioChunk(pcm(250), 0);
    await waitUntil(() => worker.gates.length === 1);
    // 20 chunk (5 s) đến trong lúc worker còn bận: trước đây chunk thứ 13 làm phiên chết.
    for (let index = 1; index <= 20; index += 1) stream.sendAudioChunk(pcm(250), index * 250);
    expect(errors).toEqual([]);
    worker.gates[0].resolve({ events: [] });
    await waitUntil(() => worker.gates.length === 2);
    const second = worker.requests.filter(request => request.op === 'audio_chunk')[1];
    expect(second).toMatchObject({ timestampMs: 250, durationMs: 4_000 });
    worker.gates[1].resolve({ events: [] });
    await waitUntil(() => worker.gates.length === 3);
    expect(worker.requests.filter(request => request.op === 'audio_chunk')[2]).toMatchObject({ timestampMs: 4_250, durationMs: 1_000 });
    worker.gates[2].resolve({ events: [] });
    expect(errors).toEqual([]);
  });

  it('bỏ audio cũ nhất khi vượt giới hạn và chỉ gửi một cảnh báo không nghiêm trọng', async () => {
    const worker = new ControlledWorker();
    const errors: Error[] = [];
    const stream = new LocalStreamingSTTProvider(worker, { modelPath: '/m', maxBufferedMs: 2_000 }).createStream('s2', {
      onInterim: () => {},
      onFinal: () => {},
      onError: error => errors.push(error)
    });
    await wait(0);
    stream.sendAudioChunk(pcm(250), 0);
    await waitUntil(() => worker.gates.length === 1);
    for (let index = 1; index <= 40; index += 1) stream.sendAudioChunk(pcm(250), index * 250);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(STTStreamError);
    expect(errors[0]).toMatchObject({ code: 'STT_OVERLOADED', fatal: false });
    worker.gates[0].resolve({ events: [] });
    await waitUntil(() => worker.gates.length === 2);
    // Chỉ giữ 2 s audio mới nhất (chunk 33..40).
    expect(worker.requests.filter(request => request.op === 'audio_chunk')[1]).toMatchObject({ timestampMs: 8_250, durationMs: 2_000 });
  });

  it('abort gửi lệnh cancel + end_stream discard và không phát kết quả của stream cũ', async () => {
    const worker = new ControlledWorker();
    const finals: string[] = [];
    const stream = new LocalStreamingSTTProvider(worker, { modelPath: '/m' }).createStream('s3', {
      onInterim: () => {},
      onFinal: result => finals.push(result.text),
      onError: () => {}
    });
    await wait(0);
    stream.sendAudioChunk(pcm(250), 0);
    await waitUntil(() => worker.gates.length === 1);
    stream.sendAudioChunk(pcm(250), 250);
    stream.abort?.();
    worker.gates[0].resolve({ events: [{ kind: 'final', text: 'stale', startMs: 0, endMs: 250 }] });
    await wait(10);
    expect(finals).toEqual([]);
    const ops = worker.requests.map(request => request.op);
    expect(ops).toContain('cancel');
    expect(worker.requests.find(request => request.op === 'end_stream')).toMatchObject({ discard: true });
    expect(ops.filter(op => op === 'audio_chunk')).toHaveLength(1);
    const key = worker.requests[0].sessionId;
    expect(worker.requests.find(request => request.op === 'cancel')?.sessionId).toBe(key);
  });

  it('mở lại stream khi worker vừa khởi động lại và mất trạng thái stream', async () => {
    const worker = new ControlledWorker();
    const errors: Error[] = [];
    const stream = new LocalStreamingSTTProvider(worker, { modelPath: '/m' }).createStream('s4', {
      onInterim: () => {},
      onFinal: () => {},
      onError: error => errors.push(error)
    });
    await wait(0);
    worker.failAudioWith = 'STT stream is not started';
    stream.sendAudioChunk(pcm(250), 0);
    await waitUntil(() => worker.requests.filter(request => request.op === 'start_stream').length === 2);
    expect(errors).toEqual([]);
  });

  it('báo lỗi nghiêm trọng STT_UNAVAILABLE sau nhiều request lỗi liên tiếp', async () => {
    const worker = new ControlledWorker();
    const errors: STTStreamError[] = [];
    const stream = new LocalStreamingSTTProvider(worker, { modelPath: '/m' }).createStream('s5', {
      onInterim: () => {},
      onFinal: () => {},
      onError: error => errors.push(error as STTStreamError)
    });
    await wait(0);
    worker.failAudioWith = 'local inference request failed';
    for (let index = 0; index < 6; index += 1) {
      stream.sendAudioChunk(pcm(250), index * 5_000);
      await wait(2);
    }
    await waitUntil(() => errors.some(error => error.fatal));
    expect(errors.filter(error => !error.fatal)).toHaveLength(1);
    expect(errors.at(-1)).toMatchObject({ code: 'STT_UNAVAILABLE', fatal: true });
  });
});

describe('local TTS scheduling (P0/P2)', () => {
  it('xếp hàng khi đang bận thay vì ném lỗi, và hủy generation cũ ở worker', async () => {
    const wav = generateSyntheticWavBuffer(0.2, 24_000).toString('base64');
    const requests: Record<string, unknown>[] = [];
    let active = 0;
    let maxActive = 0;
    const worker: LocalWorkerClientLike = {
      async request<T>(payload: Record<string, unknown>): Promise<T> {
        requests.push(payload);
        if (payload.op === 'cancel') return {} as T;
        active++;
        maxActive = Math.max(maxActive, active);
        await wait(20);
        active--;
        return { audioBase64: wav, mimeType: 'audio/wav' } as T;
      },
      async close() {}
    };
    const tts = new LocalVietnameseTTSProvider(worker, { modelPath: '/tts', maxConcurrentRequests: 1 });
    const make = (segmentId: string, generation: number): TTSRequest => ({ segmentId, text: 'Xin chào.', generation, startMs: 0, endMs: 500 });
    const results = await Promise.all([tts.synthesize(make('a', 1)), tts.synthesize(make('b', 1))]);
    expect(results.map(result => result.cancelled)).toEqual([false, false]);
    expect(maxActive).toBe(1);

    const pending = tts.synthesize(make('c', 1));
    tts.cancelGeneration(1);
    await expect(pending).resolves.toMatchObject({ cancelled: true });
    const cancel = requests.find(request => request.op === 'cancel');
    expect(cancel).toMatchObject({ beforeGeneration: 2 });
    expect(cancel?.sessionId).toBe(requests[0].sessionId);
    await expect(tts.synthesize(make('d', 1))).resolves.toMatchObject({ cancelled: true });
    await expect(tts.synthesize(make('e', 2))).resolves.toMatchObject({ cancelled: false });
  });
});

describe('worker client hardening (P2)', () => {
  it('ánh xạ phản hồi cancelled thành AbortError, cho lệnh cancel vượt giới hạn hàng đợi và ghi stderr ra log', async () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'vietdub-worker-log-'));
    const logPath = path.join(logDir, 'worker-test.log');
    const script = [
      "const readline=require('node:readline');",
      "process.stderr.write('diagnostic-line\\n');",
      "console.log(JSON.stringify({event:'ready'}));",
      "const rl=readline.createInterface({input:process.stdin});",
      "rl.on('line', line => { const msg=JSON.parse(line);",
      "  if (msg.op==='slow') { setTimeout(()=>console.log(JSON.stringify({id:msg.id,ok:true,result:{}})), 100); return; }",
      "  if (msg.op==='cancel') { console.log(JSON.stringify({id:msg.id,ok:true,result:{}})); return; }",
      "  console.log(JSON.stringify({id:msg.id,ok:false,error:'request was cancelled',cancelled:true})); });"
    ].join('');
    const client = new JsonLineWorkerClient({
      name: 'hardening-worker',
      command: { command: process.execPath, args: ['-e', script] },
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      maxQueueSize: 1,
      maxFrameBytes: 8_192,
      stderrLogPath: logPath
    });
    try {
      const slow = client.request({ op: 'slow' });
      await expect(client.request({ op: 'other' })).rejects.toThrow(/queue exceeded/);
      await expect(client.request({ op: 'cancel', sessionId: 'x' }, { bypassQueueLimit: true })).resolves.toEqual({});
      await slow;
      const cancelled = client.request({ op: 'synthesize' });
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      await waitUntil(() => {
        try {
          return readFileSync(logPath, 'utf8').includes('diagnostic-line');
        } catch {
          return false;
        }
      });
    } finally {
      await client.close();
      await wait(50);
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

class ManualSTT implements STTProvider {
  readonly name = 'ManualSTT';
  callbacks: STTStreamCallbacks | null = null;
  aborted = 0;
  ended = 0;

  createStream(_sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    this.callbacks = callbacks;
    return {
      sendAudioChunk: () => {},
      endStream: () => { this.ended++; },
      abort: () => { this.aborted++; }
    };
  }

  final(text: string, startMs: number, endMs: number): void {
    this.callbacks?.onFinal({ segmentId: `${startMs}`, text, startMs, endMs, isFinal: true, confidence: 1 });
  }
}

class SlowTTS implements TTSProvider {
  readonly name = 'SlowTTS';
  readonly synthesized: string[] = [];
  constructor(private readonly delayMs: number) {}

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    await wait(this.delayMs);
    this.synthesized.push(request.segmentId);
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

const quickTranslation: TranslationProvider = {
  name: 'QuickFixtureTranslation',
  async translate(request) {
    return { translatedText: `Câu dịch ${request.startMs}.` };
  }
};

describe('realtime pipeline decoupling (P1)', () => {
  it('dịch không chờ TTS câu trước, còn phụ đề đi liền ngay trước giọng đọc của chính câu đó', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_decouple', 'dubbing_and_subtitle', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(300),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    stt.final('First sentence.', 0, 1_000);
    stt.final('Second sentence.', 1_000, 2_000);
    stt.final('Third sentence.', 2_000, 3_000);
    await waitUntil(() => messages.filter(message => message.type === 'TRANSLATION_READY').length === 3, 250);
    // Trước đây phụ đề hiện ngay khi dịch xong và đi trước thuyết minh ~1 s; giờ phụ đề chờ giọng đọc.
    expect(messages.some(message => message.type === 'SUBTITLE_EVENT')).toBe(false);
    await waitUntil(() => messages.filter(message => message.type === 'TTS_CHUNK').length === 3, 2_000);
    const ordered = messages.filter(message => message.type === 'SUBTITLE_EVENT' || message.type === 'TTS_CHUNK');
    expect(ordered.map(message => message.type)).toEqual([
      'SUBTITLE_EVENT', 'TTS_CHUNK', 'SUBTITLE_EVENT', 'TTS_CHUNK', 'SUBTITLE_EVENT', 'TTS_CHUNK'
    ]);
    for (let index = 0; index < ordered.length; index += 2) {
      const subtitle = ordered[index] as Extract<ServerMessage, { type: 'SUBTITLE_EVENT' }>;
      const tts = ordered[index + 1] as Extract<ServerMessage, { type: 'TTS_CHUNK' }>;
      expect(subtitle.segmentId).toBe(tts.segmentId);
      expect(subtitle).toMatchObject({ syncWithTts: true, ttsDurationMs: tts.durationMs });
    }
    pipeline.stop();
  });

  it('câu cực ngắn model giữ nguyên tiếng Anh ("Oh.") bị bỏ qua lặng lẽ, câu dài thì vẫn cảnh báo', async () => {
    const echo: TranslationProvider = { name: 'EchoTranslation', async translate(request) { return { translatedText: request.sourceText }; } };
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_echo', 'subtitle_only', stt, new TranslationEngine(echo), new SlowTTS(20),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    stt.final('Oh, yeah.', 0, 1_000);
    await wait(50);
    expect(messages.some(message => message.type === 'ERROR' || message.type === 'SUBTITLE_EVENT')).toBe(false);
    stt.final('This whole sentence came back in English.', 1_000, 3_000);
    await waitUntil(() => messages.some(message => message.type === 'ERROR'));
    expect(messages.find(message => message.type === 'ERROR')).toMatchObject({ code: 'PIPELINE_ERROR', fatal: false });
    pipeline.stop();
  });

  it('chế độ chỉ phụ đề vẫn hiện phụ đề ngay khi dịch xong', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_subtitle_only', 'subtitle_only', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(300),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    stt.final('Only subtitles.', 0, 1_000);
    await waitUntil(() => messages.some(message => message.type === 'SUBTITLE_EVENT'), 250);
    const subtitle = messages.find(message => message.type === 'SUBTITLE_EVENT');
    expect(subtitle).not.toHaveProperty('syncWithTts');
    expect(messages.some(message => message.type === 'TTS_CHUNK')).toBe(false);
    pipeline.stop();
  });

  it('câu bị bỏ thuyết minh vì trễ vẫn có phụ đề (không chờ giọng đọc)', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_stale_subtitle', 'dubbing_and_subtitle', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(20),
      { sendMessage: message => messages.push(message) },
      {},
      { ttsMaxLagMs: 3_000 }
    );
    pipeline.start();
    pipeline.handleAudioChunk(pcm(250), 20_000);
    stt.final('Old sentence.', 4_000, 5_000);
    await waitUntil(() => messages.some(message => message.type === 'SUBTITLE_EVENT'));
    expect(messages.find(message => message.type === 'SUBTITLE_EVENT')).not.toHaveProperty('syncWithTts');
    expect(messages.some(message => message.type === 'TTS_CHUNK')).toBe(false);
    pipeline.stop();
  });

  it('mảnh câu chưa trọn không có câu nối tiếp thì được dịch sau thời gian chờ ngắn', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_flush', 'subtitle_only', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(20),
      { sendMessage: message => messages.push(message) },
      {},
      { pendingFlushMs: 80 }
    );
    pipeline.start();
    stt.final('And then we went over to the', 1_000, 2_000);
    await wait(30);
    expect(messages.some(message => message.type === 'SUBTITLE_EVENT')).toBe(false);
    await waitUntil(() => messages.some(message => message.type === 'SUBTITLE_EVENT'), 1_000);
    expect(messages.find(message => message.type === 'SUBTITLE_EVENT')).toMatchObject({ startMs: 1_000, endMs: 2_000 });
    pipeline.stop();
  });

  it('mảnh câu quá ngắn không bao giờ dịch riêng: ghép với câu nối tiếp hoặc bỏ nếu câu nối tiếp tới quá muộn', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_tiny', 'subtitle_only', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(20),
      { sendMessage: message => messages.push(message) },
      {},
      { pendingFlushMs: 40 }
    );
    pipeline.start();
    stt.final('There will be a', 1_000, 2_000);
    await wait(150);
    // Quá hạn flush mà vẫn không có phụ đề: dịch riêng ra chuỗi vô nghĩa nên mảnh được giữ chờ câu sau.
    expect(messages.some(message => message.type === 'SUBTITLE_EVENT')).toBe(false);
    // Câu tiếp theo bắt đầu sau > 3 s video: mảnh cũ bị bỏ, câu mới được dịch độc lập.
    stt.final('Something else entirely.', 9_000, 10_000);
    await waitUntil(() => messages.some(message => message.type === 'SUBTITLE_EVENT'));
    const subtitle = messages.find(message => message.type === 'SUBTITLE_EVENT');
    expect(subtitle).toMatchObject({ startMs: 9_000, endMs: 10_000 });
    pipeline.stop();
  });

  it('mảnh câu được ghép với câu nối tiếp nếu câu đó tới trước khi hết thời gian chờ', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_merge', 'subtitle_only', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(20),
      { sendMessage: message => messages.push(message) },
      {},
      { pendingFlushMs: 200 }
    );
    pipeline.start();
    stt.final('There will be a', 1_000, 2_000);
    await wait(30);
    stt.final('better way.', 2_000, 3_000);
    await waitUntil(() => messages.some(message => message.type === 'SUBTITLE_EVENT'));
    await wait(300);
    const subtitles = messages.filter(message => message.type === 'SUBTITLE_EVENT');
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]).toMatchObject({ startMs: 1_000, endMs: 3_000 });
    pipeline.stop();
  });

  it('bỏ câu thuyết minh đã trôi quá xa so với video và giới hạn hàng đợi TTS', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const tts = new SlowTTS(50);
    const pipeline = new RealtimePipeline(
      'pipe_stale', 'dubbing_only', stt,
      new TranslationEngine(quickTranslation), tts,
      { sendMessage: message => messages.push(message) },
      {},
      { ttsMaxLagMs: 3_000, maxPendingTts: 2 }
    );
    pipeline.start();
    // Video đã chạy tới giây 20 trong khi câu kết thúc ở giây 5.
    pipeline.handleAudioChunk(pcm(250), 20_000);
    stt.final('Old sentence.', 4_000, 5_000);
    stt.final('Fresh sentence.', 19_000, 20_000);
    await waitUntil(() => messages.filter(message => message.type === 'LATENCY_METRIC').length === 2);
    const ttsChunks = messages.filter(message => message.type === 'TTS_CHUNK');
    expect(ttsChunks).toHaveLength(1);
    const metrics = messages.filter((message): message is Extract<ServerMessage, { type: 'LATENCY_METRIC' }> => message.type === 'LATENCY_METRIC');
    expect(metrics.some(metric => (metric.videoLagMs ?? 0) >= 15_000)).toBe(true);
    pipeline.stop();
  });

  it('giới hạn tần suất cảnh báo không nghiêm trọng và dừng pipeline khi STT báo lỗi nghiêm trọng', async () => {
    const messages: ServerMessage[] = [];
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_errors', 'subtitle_only', stt,
      new TranslationEngine(quickTranslation), new SlowTTS(0),
      { sendMessage: message => messages.push(message) }
    );
    pipeline.start();
    for (let index = 0; index < 5; index += 1) stt.callbacks?.onError(new STTStreamError('STT_OVERLOADED', 'busy'));
    const warnings = messages.filter(message => message.type === 'ERROR');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'STT_OVERLOADED', fatal: false });

    stt.callbacks?.onError(new STTStreamError('STT_UNAVAILABLE', 'dead', true));
    expect(messages.at(-1)).toMatchObject({ type: 'ERROR', code: 'STT_UNAVAILABLE', fatal: true });
    expect(stt.aborted).toBe(1);
    stt.final('After stop.', 0, 1_000);
    await wait(20);
    expect(messages.some(message => message.type === 'SUBTITLE_EVENT')).toBe(false);
  });

  it('dùng abort (không chốt câu cũ) khi tua', () => {
    const stt = new ManualSTT();
    const pipeline = new RealtimePipeline(
      'pipe_seek', 'subtitle_only', stt,
      new TranslationEngine(new DeterministicTranslationProvider()), new SlowTTS(0),
      { sendMessage: () => {} }
    );
    pipeline.start();
    pipeline.handleSeek(1_000, 60_000);
    expect(stt.aborted).toBe(1);
    expect(stt.ended).toBe(0);
    pipeline.stop();
    expect(stt.aborted).toBe(2);
  });
});

describe('translation fragment flush (P1)', () => {
  it('buộc dịch đoạn chưa trọn câu khi chờ quá lâu để phụ đề không bị treo', async () => {
    const engine = new TranslationEngine(quickTranslation, undefined, { maxPendingDurationMs: 4_000, validateVietnamese: false });
    const first = await engine.translate('We went to the store and', 0, 2_000);
    expect(first.buffered).toBe(true);
    const second = await engine.translate('then we walked with', 2_000, 4_500);
    expect(second.buffered).toBe(false);
    expect(second.sourceText).toBe('We went to the store and then we walked with');
    expect(second.startMs).toBe(0);
  });
});
