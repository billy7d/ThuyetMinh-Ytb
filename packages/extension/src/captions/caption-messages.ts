/** Bản tin window.postMessage giữa content script và script trong trang YouTube (youtube-captions-main.ts). */
import type { CaptionWord, ScriptSegment } from '@vietdub/shared';
import { buildCaptionScript, parseAsrWords } from './caption-script.js';

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
  kind?: 'manual' | 'asr';
  json?: unknown;
  /** Lý do không có phụ đề: no-captions, no-english, no-pot-url, player-not-ready, empty-<status>… */
  reason?: string;
}

export interface CaptionScriptResult {
  /** Phụ đề do người làm: câu đã ghép sẵn. */
  segments: ScriptSegment[];
  /** Phụ đề tự động: từng từ kèm mốc, cần backend thêm dấu câu (CAPTION_WORDS). */
  asrWords: CaptionWord[];
  /** Có phụ đề thì rỗng; không có thì là lý do (để ghi chẩn đoán). */
  reason: string;
}

export function hasCaptions(result: CaptionScriptResult): boolean {
  return result.segments.length > 0 || result.asrWords.length > 0;
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
        finish({ segments: [], asrWords: [], reason: data.reason || 'unknown' });
        return;
      }
      try {
        if (data.kind === 'asr') {
          const asrWords = parseAsrWords(data.json);
          finish({ segments: [], asrWords, reason: asrWords.length > 0 ? '' : 'empty-track' });
          return;
        }
        const segments = buildCaptionScript(data.json);
        finish({ segments, asrWords: [], reason: segments.length > 0 ? '' : 'empty-track' });
      } catch (error) {
        finish({ segments: [], asrWords: [], reason: `parse-failed: ${String(error).slice(0, 80)}` });
      }
    };
    const timer = setTimeout(() => finish({ segments: [], asrWords: [], reason: 'timeout' }), timeoutMs);
    target.addEventListener('message', onMessage);
    const request: CaptionsRequest = { __vietdub: CAPTIONS_REQUEST, requestId, videoId };
    target.postMessage(request, target.location.origin);
  });
}
