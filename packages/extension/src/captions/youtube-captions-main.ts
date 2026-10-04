/**
 * Chạy trong ngữ cảnh trang YouTube (content script "world": "MAIN", document_start). Content script thường không gọi được
 * API trình phát và YouTube từ chối tải phụ đề nếu thiếu mã `pot` (proof of origin) mà chỉ trình phát mới có, nên script này:
 *  1. bắt đường dẫn /api/timedtext có `pot` mà trình phát tự gọi (XHR/fetch) cho từng video;
 *  2. khi content script hỏi: nếu chưa có thì chờ hết quảng cáo rồi buộc trình phát tải phụ đề (chọn rãnh tiếng Anh, hoặc tạm
 *     chuyển sang rãnh khác nếu rãnh đó đã tải sẵn), sau đó trả lại rãnh và trạng thái nút CC như cũ;
 *  3. tải rãnh tiếng Anh do người làm (không dùng phụ đề tự động) dạng json3 và trả về qua window.postMessage.
 */
import { CAPTIONS_REQUEST, CAPTIONS_RESPONSE, CaptionsRequest, CaptionsResponse } from './caption-messages.js';

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

const MAIN_FLAG = '__VIETDUB_CAPTIONS_MAIN__';
const TRIGGER_WAIT_MS = 3_000;
/** Đang chạy quảng cáo thì trình phát không tải phụ đề của video chính: chờ tối đa chừng này. */
const AD_WAIT_MS = 60_000;

if (!(window as any)[MAIN_FLAG]) {
  (window as any)[MAIN_FLAG] = true;
  const potUrls = new Map<string, string>();
  const waiters = new Set<() => void>();

  const remember = (rawUrl: unknown): void => {
    try {
      const url = new URL(String(rawUrl), location.href);
      if (!url.pathname.endsWith('/api/timedtext') || !url.searchParams.has('pot')) return;
      const videoId = url.searchParams.get('v');
      if (!videoId) return;
      potUrls.set(videoId, url.href);
      for (const wake of [...waiters]) wake();
    } catch {}
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
    remember(args[1]);
    return (originalOpen as any).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0];
    remember(typeof input === 'string' || input instanceof URL ? input : (input as Request)?.url);
    return originalFetch.apply(this as any, args);
  } as typeof fetch;

  const player = (): any => document.getElementById('movie_player');
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const waitForPotUrl = (videoId: string, timeoutMs: number): Promise<string | undefined> => {
    if (potUrls.has(videoId)) return Promise.resolve(potUrls.get(videoId));
    return new Promise(resolve => {
      const done = () => {
        if (!potUrls.has(videoId) && Date.now() < deadline) return;
        waiters.delete(done);
        clearTimeout(timer);
        resolve(potUrls.get(videoId));
      };
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  };

  /** Rãnh tiếng Anh do người làm: ưu tiên "en", sau đó "en-US", "en-GB"… */
  const pickTrack = (tracks: CaptionTrack[]): CaptionTrack | undefined => {
    const manual = tracks.filter(track => !track.kind && /^en(?:-|$)/i.test(track.languageCode ?? ''));
    return manual.find(track => track.languageCode?.toLowerCase() === 'en') ?? manual[0];
  };

  const captionsButton = (): HTMLElement | null => document.querySelector('.ytp-subtitles-button');
  const captionsOn = (): boolean => captionsButton()?.getAttribute('aria-pressed') === 'true';

  const adShowing = (): boolean => Boolean(document.querySelector('#movie_player.ad-showing'));

  /** Buộc trình phát gọi /api/timedtext (có pot) cho video hiện tại, rồi trả rãnh và nút CC về trạng thái cũ. */
  const triggerCaptionLoad = async (videoId: string, track: CaptionTrack, tracks: CaptionTrack[]): Promise<string | undefined> => {
    const adDeadline = Date.now() + AD_WAIT_MS;
    while (adShowing() && !potUrls.has(videoId) && Date.now() < adDeadline) await sleep(500);
    if (potUrls.has(videoId)) return potUrls.get(videoId);
    const p = player();
    const wasOn = captionsOn();
    const previous = p?.getOption?.('captions', 'track');
    try {
      p?.loadModule?.('captions');
      p?.setOption?.('captions', 'track', { languageCode: track.languageCode });
      let url = await waitForPotUrl(videoId, TRIGGER_WAIT_MS);
      // Rãnh đã được tải từ trước (trình phát dùng lại, không gọi mạng): tạm chuyển sang rãnh khác để trình phát gọi lại.
      const other = tracks.find(candidate => candidate !== track && candidate.languageCode);
      if (!url && other) {
        p?.setOption?.('captions', 'track', { languageCode: other.languageCode, ...(other.kind ? { kind: other.kind } : {}) });
        url = await waitForPotUrl(videoId, TRIGGER_WAIT_MS);
      }
      if (!url && !captionsOn()) {
        captionsButton()?.click();
        url = await waitForPotUrl(videoId, TRIGGER_WAIT_MS);
      }
      return url;
    } finally {
      if (wasOn && previous?.languageCode) p?.setOption?.('captions', 'track', previous);
      if (!wasOn && captionsOn()) {
        captionsButton()?.click();
        await sleep(50);
        if (captionsOn()) player()?.unloadModule?.('captions');
      }
    }
  };

  const loadCaptions = async (request: CaptionsRequest): Promise<CaptionsResponse> => {
    const base = { __vietdub: CAPTIONS_RESPONSE, requestId: request.requestId } as const;
    const response = player()?.getPlayerResponse?.();
    if (response?.videoDetails?.videoId !== request.videoId) return { ...base, ok: false, reason: 'player-not-ready' };
    const tracks: CaptionTrack[] = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = pickTrack(tracks);
    if (!track?.languageCode) return { ...base, ok: false, reason: tracks.length > 0 ? 'no-manual-english' : 'no-captions' };
    const potUrl = potUrls.get(request.videoId) ?? await triggerCaptionLoad(request.videoId, track, tracks);
    if (!potUrl) return { ...base, ok: false, reason: 'no-pot-url' };

    const statuses: string[] = [];
    for (const url of captionUrls(potUrl, track)) {
      const result = await originalFetch.call(window, url, { credentials: 'include' });
      const text = result.ok ? await result.text() : '';
      if (text) return { ...base, ok: true, languageCode: track.languageCode, json: JSON.parse(text) };
      statuses.push(String(result.status));
    }
    const captured = new URL(potUrl).searchParams;
    // Lý do kèm loại rãnh trình phát đã gọi (không chứa nội dung) để chẩn đoán.
    return { ...base, ok: false, reason: `empty-${statuses.join('/')}:${captured.get('kind') ?? 'manual'}:${captured.get('variant') ?? ''}` };
  };

  /**
   * Đường dẫn tải rãnh đã chọn: (1) đường dẫn riêng của rãnh (chữ ký riêng) + mã pot và tham số client lấy từ request của trình phát;
   * (2) dự phòng: đường dẫn trình phát đã gọi, đổi các tham số chọn rãnh (bỏ `variant` của phụ đề tự động).
   */
  const captionUrls = (potUrl: string, track: CaptionTrack): string[] => {
    const captured = new URL(potUrl);
    const urls: string[] = [];
    if (track.baseUrl) {
      const own = new URL(track.baseUrl, location.href);
      for (const [key, value] of captured.searchParams) {
        if (key === 'pot' || key === 'potc' || /^(c|cver|cplayer|cos|cosver|cplatform|cbr|cbrver|xorb|xobt|xovt)$/.test(key)) own.searchParams.set(key, value);
      }
      own.searchParams.set('fmt', 'json3');
      urls.push(own.href);
    }
    const rewritten = new URL(potUrl);
    const trackParams = new URL(track.baseUrl ?? '', location.href).searchParams;
    for (const key of ['lang', 'kind', 'name', 'tlang', 'variant']) {
      const value = trackParams.get(key);
      if (value === null) rewritten.searchParams.delete(key);
      else rewritten.searchParams.set(key, value);
    }
    rewritten.searchParams.set('lang', track.languageCode ?? 'en');
    rewritten.searchParams.set('fmt', 'json3');
    urls.push(rewritten.href);
    return urls;
  };

  window.addEventListener('message', event => {
    const data = event.data as CaptionsRequest | undefined;
    if (event.source !== window || data?.__vietdub !== CAPTIONS_REQUEST || typeof data.videoId !== 'string') return;
    void loadCaptions(data)
      .catch(error => ({ __vietdub: CAPTIONS_RESPONSE, requestId: data.requestId, ok: false, reason: String(error).slice(0, 120) }) as CaptionsResponse)
      .then(reply => window.postMessage(reply, location.origin));
  });
}
