/**
 * Chia câu thuyết minh dài thành các vế ở dấu phẩy/chấm phẩy/hai chấm để tổng hợp và phát từng vế:
 * vế đầu xong là phát ngay trong lúc vế sau đang tổng hợp, nên giọng đọc bắt đầu sớm hơn nhiều so với đợi cả câu
 * (RTF ~0.5–0.8 trên CPU: câu 12 s mất 6–8 s mới có tiếng). Chỉ cắt ở dấu câu có sẵn để ngắt nghỉ vẫn như người nói.
 */

export interface SplitOptions {
  /** Câu ngắn hơn ngưỡng này (ký tự) đọc nguyên câu: lợi ích nhỏ, còn cắt vế dễ làm giọng rời rạc. */
  minTotalChars?: number;
  /** Mỗi vế tối thiểu chừng này ký tự. */
  minPartChars?: number;
  maxParts?: number;
}

const BOUNDARY = /[,;:](?=\s)/g;

export function splitForStreaming(text: string, options: SplitOptions = {}): string[] {
  const minTotal = options.minTotalChars ?? 90;
  const minPart = options.minPartChars ?? 28;
  const maxParts = options.maxParts ?? 3;
  const full = text.trim();
  if (full.length < minTotal || maxParts < 2) return [full];

  const parts: string[] = [];
  let rest = full;
  while (parts.length < maxParts - 1 && rest.length >= (parts.length === 0 ? minTotal : minTotal + 20)) {
    // Vế đầu ngắn hơn (~40%) để có tiếng sớm; các vế sau chia đôi phần còn lại.
    const target = Math.max(minPart, rest.length * (parts.length === 0 ? 0.4 : 0.5));
    let best = -1;
    for (const match of rest.matchAll(BOUNDARY)) {
      const cut = (match.index ?? 0) + 1;
      if (cut < minPart || rest.length - cut < minPart) continue;
      if (best < 0 || Math.abs(cut - target) < Math.abs(best - target)) best = cut;
    }
    if (best < 0) break;
    parts.push(rest.slice(0, best).trim());
    rest = rest.slice(best).trim();
  }
  parts.push(rest);
  return parts;
}
