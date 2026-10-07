/**
 * Nút "Bật backend": extension không tự chạy được chương trình trên máy, nên nhờ native messaging host
 * (runtime/native-host, cài một lần bằng runtime/install_native_host.ps1) chạy runtime/start_backend.ps1.
 */
export const NATIVE_HOST_NAME = 'com.vietdub.backend_launcher';
export const BACKEND_HEALTH_URL = 'http://127.0.0.1:8080/health';

/** down: không có gì trả lời; warming: có trả lời nhưng chưa sẵn sàng (đang nạp model); ready: dùng được. */
export type BackendState = 'down' | 'warming' | 'ready';

export type LaunchFailure = 'host-missing' | 'forbidden' | 'script-missing' | 'host-error';

export type LaunchResult =
  | { ok: true; state: BackendState | 'starting' | 'started' }
  | { ok: false; reason: LaunchFailure; detail?: string };

interface HostResponse {
  ok?: boolean;
  state?: string;
  error?: string;
  detail?: string;
}

interface NativeRuntime {
  sendNativeMessage(host: string, message: object, callback: (response?: unknown) => void): void;
  lastError?: { message?: string } | null;
}

export async function probeBackend(fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<BackendState> {
  try {
    const response = await fetchImpl(BACKEND_HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return 'warming';
    const payload = await response.json().catch(() => ({}));
    const providers = payload?.providers || payload;
    return providers?.mode === 'local' && providers?.configured ? 'ready' : 'warming';
  } catch {
    return 'down';
  }
}

/** Chrome và Firefox báo lỗi host qua runtime.lastError với các câu cố định (Firefox: "No such native application <tên>"). */
export function classifyHostError(message: string | undefined): LaunchFailure {
  const text = (message || '').toLowerCase();
  if (text.includes('not found') || text.includes('not registered') || text.includes('no such native application')) return 'host-missing';
  if (text.includes('forbidden') || text.includes('does not have access') || text.includes('permission denied')) return 'forbidden';
  return 'host-error';
}

/** Nhờ host bật backend (một lần hỏi - một lần trả lời). Không bao giờ ném lỗi: kết quả luôn là LaunchResult. */
export function launchBackend(runtime: NativeRuntime = chrome.runtime as unknown as NativeRuntime): Promise<LaunchResult> {
  return new Promise(resolve => {
    try {
      runtime.sendNativeMessage(NATIVE_HOST_NAME, { command: 'start' }, response => {
        const lastError = runtime.lastError;
        if (lastError) {
          resolve({ ok: false, reason: classifyHostError(lastError.message), detail: lastError.message });
          return;
        }
        const reply = response as HostResponse | undefined;
        if (reply?.ok) {
          resolve({ ok: true, state: (reply.state as BackendState | 'starting' | 'started') || 'started' });
        } else if (reply?.error === 'script-missing') {
          resolve({ ok: false, reason: 'script-missing' });
        } else {
          resolve({ ok: false, reason: 'host-error', detail: reply?.error || reply?.detail });
        }
      });
    } catch (error) {
      resolve({ ok: false, reason: 'host-error', detail: String(error) });
    }
  });
}

export interface WaitOptions {
  probe: () => Promise<BackendState>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Gọi mỗi lần thăm dò để popup cập nhật trạng thái. */
  onState?: (state: BackendState) => void;
  isCancelled?: () => boolean;
}

/** Chờ backend sẵn sàng: true nếu sẵn sàng trước hạn, false nếu hết hạn hoặc bị hủy. Nạp model mất ~1-2 phút. */
export async function waitUntilReady(options: WaitOptions): Promise<boolean> {
  const { probe, intervalMs = 2_000, timeoutMs = 240_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = options;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (options.isCancelled?.()) return false;
    const state = await probe();
    options.onState?.(state);
    if (state === 'ready') return true;
    await sleep(intervalMs);
  }
  return false;
}
