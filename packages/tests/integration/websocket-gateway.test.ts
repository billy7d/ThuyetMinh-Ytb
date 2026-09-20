import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '@vietdub/backend';
import { ServerMessage } from '@vietdub/shared';
import { createFixtureProviderFactory } from '../src/fixtures/provider-factory.js';

function makeVoicePcm(): Buffer {
  const buffer = Buffer.alloc(3200);
  for (let index = 0; index < buffer.length; index += 2) {
    buffer.writeInt16LE(Math.floor(Math.sin(index / 10) * 15000), index);
  }
  return buffer;
}

async function waitForMessage(messages: ServerMessage[], type: ServerMessage['type']): Promise<ServerMessage> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const message = messages.find((item) => item.type === type);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Không nhận được message ${type} trong thời hạn kiểm thử.`);
}

describe('WebSocket gateway runtime pipeline', () => {
  it('nhận SESSION_START/AUDIO_CHUNK thật và phát đủ subtitle/TTS mock events', async () => {
    const { server, gateway } = createServer(0, { providerFactory: createFixtureProviderFactory(["Let's break it down."]) });
    const messages: ServerMessage[] = [];
    const sessionId = 'gateway_runtime_regression';
    let socket: WebSocket | null = null;

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Không lấy được cổng gateway test.');

      socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
      await once(socket, 'open');

      socket.send(JSON.stringify({
        type: 'SESSION_START',
        sessionId,
        timestamp: Date.now(),
        mode: 'dubbing_and_subtitle',
        audioSampleRate: 16000
      }));
      await waitForMessage(messages, 'SESSION_READY');

      const voice = makeVoicePcm();
      const silence = Buffer.alloc(3200);
      const audioChunks = [
        [voice, 0],
        [voice, 100],
        [voice, 200],
        [voice, 300],
        [silence, 400],
        [silence, 700],
        [silence, 1000]
      ] as const;
      audioChunks.forEach(([pcm, timestampMs], sequence) => {
        socket?.send(JSON.stringify({
          type: 'AUDIO_CHUNK',
          sessionId,
          timestamp: Date.now(),
          sequence,
          pcmBase64: pcm.toString('base64'),
          videoTimeMs: timestampMs
        }));
      });

      await waitForMessage(messages, 'TRANSCRIPT_FINAL');
      await waitForMessage(messages, 'TRANSLATION_READY');
      await waitForMessage(messages, 'SUBTITLE_EVENT');
      const tts = await waitForMessage(messages, 'TTS_CHUNK');
      expect((tts as Extract<ServerMessage, { type: 'TTS_CHUNK' }>).audioBase64).toBeTruthy();

      socket.send(JSON.stringify({ type: 'SESSION_STOP', sessionId, timestamp: Date.now(), reason: 'test' }));
      await waitForMessage(messages, 'SESSION_METRICS');
    } finally {
      socket?.close();
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
