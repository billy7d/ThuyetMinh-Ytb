/**
 * Danh tính video của một URL, dùng để phân biệt "chuyển sang video khác" với
 * việc trang tự sửa URL. YouTube liên tục thay query (`&t=`, `&pp=`, sau quảng
 * cáo, replaceState…) trong khi vẫn phát cùng một video; so sánh nguyên URL làm
 * phiên thuyết minh bị dừng giữa chừng mà người dùng không hề chuyển video.
 */
export function videoIdentity(rawUrl: string | undefined | null): string {
  if (!rawUrl) return '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      const videoId = url.searchParams.get('v');
      if (videoId) return `youtube:${videoId}`;
    }
    const match = url.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
    if (match) return `youtube:${match[2]}`;
  }
  if (host === 'youtu.be') {
    const videoId = url.pathname.split('/').filter(Boolean)[0];
    if (videoId) return `youtube:${videoId}`;
  }
  // Trang khác: bỏ query/hash vì thường chỉ là tham số theo dõi hoặc vị trí phát.
  return `${url.origin}${url.pathname}`;
}

export function isSameVideo(previousUrl: string | undefined | null, nextUrl: string | undefined | null): boolean {
  return videoIdentity(previousUrl) === videoIdentity(nextUrl);
}
