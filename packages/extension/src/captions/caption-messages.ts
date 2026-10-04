/** Bản tin window.postMessage giữa content script và script trong trang YouTube (youtube-captions-main.ts). */
import type { ScriptSegment } from '@vietdub/shared';
import { buildCaptionScript } from './caption-script.js';

export const CAPTIONS_REQUEST = 'vietdub-captions-request';
export const CAPTIONS_RESPONSE = 'vietdub-captions-response';

export interface CaptionsRequest {
  __vietdub: typeof CAPTIONS_REQUEST;
  requestId: string;
  videoId: string;
}

export interface CaptionsResponse {
  __vietdub: typeof CAPTIONS_RESPONSE;
  requestId: string;
  ok: boolean;
  languageCode?: string;
  json?: unknown;
  /** Lý do không có phụ đề: no-captions, no-manual-english, no-pot-url, player-not-ready, empty-<status>… */
  reason?: string;
}

export interface CaptionScriptResult {
  segments: ScriptSegment[];
  /** Có câu thì rỗng; không có thì là lý do (để ghi chẩn đoán). */
  reason: string;
}

/** Mã video YouTube của trang hiện tại (watch?v=… hoặc /shorts/…, /live/…). */
export function youtubeVideoId(href: string): string | null {
  try {
    const url = new URL(href);
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
    const fromQuery = url.searchParams.get('v');
    if (fromQuery) return fromQuery;
    return /^\/(?:shorts|live)\/([\w-]{6,})/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Hỏi script trong trang lấy phụ đề tiếng Anh do người làm của video và ghép thành câu. */
export function requestCaptionScript(videoId: string, timeoutMs = 90_000, target: Window = window): Promise<CaptionScriptResult> {
  const requestId = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise(resolve => {
    const finish = (result: CaptionScriptResult) => {
      target.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as CaptionsResponse | undefined;
      if (data?.__vietdub !== CAPTIONS_RESPONSE || data.requestId !== requestId) return;
      if (!data.ok) {
        finish({ segments: [], reason: data.reason || 'unknown' });
        return;
      }
      try {
        const segments = buildCaptionScript(data.json);
        finish({ segments, reason: segments.length > 0 ? '' : 'empty-track' });
      } catch (error) {
        finish({ segments: [], reason: `parse-failed: ${String(error).slice(0, 80)}` });
      }
    };
    const timer = setTimeout(() => finish({ segments: [], reason: 'timeout' }), timeoutMs);
    target.addEventListener('message', onMessage);
    const request: CaptionsRequest = { __vietdub: CAPTIONS_REQUEST, requestId, videoId };
    target.postMessage(request, target.location.origin);
  });
}
