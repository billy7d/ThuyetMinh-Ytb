import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CostTracker,
  LocalModelManager,
  LocalStreamingSTTProvider,
  LocalTranslationProvider,
  LocalVietnameseTTSProvider,
  JsonLineWorkerClient,
  LocalWorkerClientLike,
  downloadVerifiedModel,
  generateSyntheticWavBuffer
} from '@vietdub/backend';

class FakeWorker implements LocalWorkerClientLike {
  readonly requests: Record<string, unknown>[] = [];
  private readonly wav = generateSyntheticWavBuffer(0.8, 24_000);

  async request<T>(payload: Record<string, unknown>): Promise<T> {
    this.requests.push(payload);
    if (payload.op === 'audio_chunk') {
      return {
        events: [{
          kind: 'final',
          segmentId: 'local_1',
          text: 'Hello from local worker.',
          startMs: payload.timestampMs,
          endMs: Number(payload.timestampMs) + Number(payload.durationMs),
          confidence: 0.9
        }]
      } as T;
    }
    if (payload.op === 'translate') return { translatedText: 'Xin chào từ worker local.' } as T;
    if (payload.op === 'synthesize') {
      return {
        audioBase64: this.wav.toString('base64'),
        mimeType: 'audio/wav'
      } as T;
    }
    return {} as T;
  }

  async close(): Promise<void> {}
}

describe('local runtime contracts', () => {
  it('uses a bounded JSONL child process without shell interpolation', async () => {
    const workerScript = [
      "const readline=require('node:readline');",
      "console.log(JSON.stringify({event:'ready'}));",
      "const rl=readline.createInterface({input:process.stdin});",
      "rl.on('line', line => { const msg=JSON.parse(line); console.log(JSON.stringify({id:msg.id,ok:true,result:{value:msg.value}})); });"
    ].join('');
    const client = new JsonLineWorkerClient({
      name: 'test-worker',
      command: { command: process.execPath, args: ['-e', workerScript] },
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      maxQueueSize: 1,
      maxFrameBytes: 8_192
    });
    await expect(client.request<{ value: string }>({ op: 'echo', value: 'local-only' })).resolves.toEqual({ value: 'local-only' });
    await client.close();
  });

  it('verifies all model artifacts and licenses before readiness', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vietdub-model-'));
    try {
      const entries = {} as Record<string, unknown>;
      for (const component of ['stt', 'translation', 'tts']) {
        const dir = path.join(root, component);
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'model.bin');
        const content = Buffer.from(`${component}-model`);
        writeFileSync(file, content);
        entries[component] = {
          component,
          modelId: `local/${component}`,
          revision: 'rev-1',
          upstreamUrl: 'https://example.test/model',
          relativePath: component,
          artifacts: [{
            relativePath: 'model.bin',
            sizeBytes: content.length,
            sha256: createHash('sha256').update(content).digest('hex')
          }],
          license: {
            model: 'MIT',
            code: 'MIT',
            tokenizer: 'MIT',
            ...(component === 'tts' ? { codec: 'MIT', voice: 'MIT' } : {}),
            distribution: 'verified',
            commercialUse: 'verified'
          }
        };
      }
      const manifestPath = path.join(root, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-21T00:00:00Z',
        models: entries
      }));

      const manager = new LocalModelManager(manifestPath, root);
      const status = manager.getStatus();
      expect(status.ready).toBe(true);
      expect(status.components.stt.readiness).toBe('ready');
      expect(manager.getModelPath('translation')).toBe(path.join(root, 'translation'));

      writeFileSync(path.join(root, 'tts', 'model.bin'), 'tampered');
      expect(manager.getStatus().ready).toBe(false);
      expect(manager.getStatus().components.tts.errors.join(' ')).toMatch(/size mismatch|SHA-256 mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps local STT, translation and TTS behind a worker-only boundary', async () => {
    const worker = new FakeWorker();
    const stt = new LocalStreamingSTTProvider(worker, { modelPath: '/models/stt' });
    const results: string[] = [];
    const stream = stt.createStream('session-1', {
      onInterim: result => results.push(`interim:${result.text}`),
      onFinal: result => results.push(`final:${result.text}`),
      onError: error => results.push(`error:${error.message}`)
    });
    stream.sendAudioChunk(Buffer.alloc(8000), 1000);
    stream.sendAudioChunk(Buffer.alloc(8000), 1500);
    stream.endStream();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(results).toEqual([
      'final:Hello from local worker.',
      'final:Hello from local worker.'
    ]);

    const translation = new LocalTranslationProvider(worker, { modelPath: '/models/translation' });
    await expect(translation.translate({
      sourceText: 'Hello.',
      startMs: 0,
      endMs: 1000,
      context: [],
      terminology: {},
      speakerTone: 'natural'
    })).resolves.toMatchObject({ translatedText: 'Xin chào từ worker local.' });

    const tts = new LocalVietnameseTTSProvider(worker, { modelPath: '/models/tts' });
    const response = await tts.synthesize({
      segmentId: 'seg-1',
      text: 'Xin chào.',
      generation: 1,
      startMs: 0,
      endMs: 1000
    });
    expect(response.mimeType).toBe('audio/wav');
    expect(response.durationMs).toBe(800);
    expect(response.audioBase64.length).toBeGreaterThan(44);
    expect(worker.requests.map(request => request.op)).toEqual([
      'start_stream',
      'audio_chunk',
      'audio_chunk',
      'end_stream',
      'translate',
      'synthesize'
    ]);
  });

  it('requires explicit consent and verifies downloaded bytes before install', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vietdub-download-'));
    try {
      const body = Buffer.from('verified-model');
      const sha256 = createHash('sha256').update(body).digest('hex');
      await expect(downloadVerifiedModel({
        url: 'https://models.example.test/rev/model.bin',
        destination: path.join(root, 'model.bin'),
        expectedSizeBytes: body.length,
        expectedSha256: sha256,
        consentAccepted: false,
        fetchImpl: async () => new Response(body)
      })).rejects.toThrow(/explicit consent/);

      await downloadVerifiedModel({
        url: 'https://models.example.test/rev/model.bin',
        destination: path.join(root, 'model.bin'),
        expectedSizeBytes: body.length,
        expectedSha256: sha256,
        consentAccepted: true,
        allowedHosts: ['models.example.test'],
        fetchImpl: async () => new Response(body)
      });
      expect(readFileSync(path.join(root, 'model.bin')).equals(body)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports zero external API cost in local mode', () => {
    const tracker = new CostTracker('local-session', { costMode: 'local' });
    tracker.recordAudioChunk(120);
    tracker.recordTranslation(500);
    tracker.recordTTS(600);
    expect(tracker.getMetrics().estimatedCostUsd).toBe(0);
  });
});
