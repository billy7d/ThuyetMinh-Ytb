import { describe, expect, it } from 'vitest';
import {
  BACKEND_HEALTH_URL,
  NATIVE_HOST_NAME,
  classifyHostError,
  launchBackend,
  probeBackend,
  waitUntilReady
} from '../../extension/src/backend/backend-launcher.js';

function fakeRuntime(handler: (message: any) => { response?: unknown; error?: string } | 'throw') {
  const runtime = {
    lastError: null as { message?: string } | null,
    calls: [] as Array<{ host: string; message: any }>,
    sendNativeMessage(host: string, message: object, callback: (response?: unknown) => void) {
      runtime.calls.push({ host, message });
      const result = handler(message);
      if (result === 'throw') throw new Error('Access to the specified native messaging host is forbidden.');
      runtime.lastError = result.error ? { message: result.error } : null;
      callback(result.response);
      runtime.lastError = null;
    }
  };
  return runtime;
}

const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('backend launcher (phía extension)', () => {
  it('probeBackend: ready chỉ khi 200 và providers cấu hình đủ; 503 hoặc chưa cấu hình là warming; không kết nối là down', async () => {
    expect(await probeBackend(json(200, { mode: 'local', configured: true }))).toBe('ready');
    expect(await probeBackend(json(200, { providers: { mode: 'local', configured: true } }))).toBe('ready');
    expect(await probeBackend(json(200, { mode: 'local', configured: false }))).toBe('warming');
    expect(await probeBackend(json(503, { mode: 'local' }))).toBe('warming');
    expect(await probeBackend((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toBe('down');
  });

  it('gọi đúng host, đúng lệnh cố định "start" và không gửi gì khác', async () => {
    const runtime = fakeRuntime(() => ({ response: { ok: true, state: 'started', pid: 123 } }));
    const result = await launchBackend(runtime);
    expect(result).toEqual({ ok: true, state: 'started' });
    expect(runtime.calls).toEqual([{ host: NATIVE_HOST_NAME, message: { command: 'start' } }]);
    expect(NATIVE_HOST_NAME).toBe('com.vietdub.backend_launcher');
    expect(BACKEND_HEALTH_URL).toBe('http://127.0.0.1:8080/health');
  });

  it('các lỗi của Chrome được phân loại thành thông điệp hướng dẫn được', async () => {
    expect(classifyHostError('Specified native messaging host not found.')).toBe('host-missing');
    expect(classifyHostError('Access to the specified native messaging host is forbidden.')).toBe('forbidden');
    expect(classifyHostError('Native host has exited.')).toBe('host-error');
    // Firefox
    expect(classifyHostError('No such native application com.vietdub.backend_launcher')).toBe('host-missing');
    expect(classifyHostError('This extension does not have access to the native application com.vietdub.backend_launcher')).toBe('forbidden');
    expect(await launchBackend(fakeRuntime(() => ({ error: 'Specified native messaging host not found.' })))).toMatchObject({ ok: false, reason: 'host-missing' });
    expect(await launchBackend(fakeRuntime(() => ({ error: 'Access to the specified native messaging host is forbidden.' })))).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('host trả lỗi hoặc ném ngoại lệ: luôn trả LaunchResult, không ném', async () => {
    expect(await launchBackend(fakeRuntime(() => ({ response: { ok: false, error: 'script-missing' } })))).toEqual({ ok: false, reason: 'script-missing' });
    expect(await launchBackend(fakeRuntime(() => ({ response: { ok: false, error: 'launch-failed' } })))).toMatchObject({ ok: false, reason: 'host-error' });
    expect(await launchBackend(fakeRuntime(() => ({ response: undefined })))).toMatchObject({ ok: false, reason: 'host-error' });
    expect(await launchBackend(fakeRuntime(() => 'throw'))).toMatchObject({ ok: false, reason: 'host-error' });
  });

  it('waitUntilReady: thăm dò đến khi ready, báo từng trạng thái, dừng khi hết hạn hoặc bị hủy', async () => {
    let clock = 0;
    const sequence = ['down', 'warming', 'warming', 'ready'] as const;
    let index = 0;
    const seen: string[] = [];
    const ready = await waitUntilReady({
      probe: async () => sequence[Math.min(index++, sequence.length - 1)],
      onState: state => seen.push(state),
      sleep: async ms => { clock += ms; },
      now: () => clock
    });
    expect(ready).toBe(true);
    expect(seen).toEqual(['down', 'warming', 'warming', 'ready']);

    clock = 0;
    const never = await waitUntilReady({ probe: async () => 'warming', timeoutMs: 10_000, intervalMs: 2_000, sleep: async ms => { clock += ms; }, now: () => clock });
    expect(never).toBe(false);
    expect(clock).toBe(10_000);

    let cancel = false;
    let polls = 0;
    const cancelled = await waitUntilReady({
      probe: async () => { polls += 1; cancel = true; return 'down'; },
      isCancelled: () => cancel,
      sleep: async () => undefined
    });
    expect(cancelled).toBe(false);
    expect(polls).toBe(1);
  });
});
