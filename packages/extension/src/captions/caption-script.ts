/**
 * Đọc phụ đề YouTube (định dạng json3 của /api/timedtext) để thuyết minh trước:
 * - Tiếng Việt của YouTube (do người làm, hoặc bản dịch tự động tlang=vi): đọc NGUYÊN VĂN, không dịch lại. Dòng phụ đề bị YouTube cắt
 *   giữa câu ("…theo một số cách... ý tôi là, mỗi" / "khi chúng ta làm điều gì đó"), nên ghép lại thành câu theo dấu câu tiếng Việt
 *   và khoảng ngừng của người nói (mốc từng từ), rồi mới đọc: chỉ quyết định chỗ ngắt, không đổi chữ.
 * - Do người làm: ghép thành câu có mốc thời gian, tách câu theo dấu chấm/hỏi/than, một dòng chứa hai câu thì chia mốc theo số ký tự.
 * - Tự động (ASR): chỉ lấy từng từ kèm mốc; không có dấu câu nên ghép câu theo khoảng ngừng sai ranh giới câu
 *   ("…one is the extraordinary." + "Evidence of human creativity…"). Từ được gửi lên backend thêm dấu câu bằng mô hình rồi mới tách câu.
 */
import type { CaptionWord, ScriptSegment } from '@vietdub/shared';

interface Json3Seg {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

interface TimedText {
  text: string;
  startMs: number;
  endMs: number;
}

/** Câu dài hơn chừng này (ms) được cắt ở ranh giới dòng phụ đề gần nhất để giọng đọc không chờ quá lâu. */
const MAX_SENTENCE_MS = 14_000;
const MAX_SENTENCE_CHARS = 280;
/** Hai dòng phụ đề cách nhau quá chừng này (ms) thì coi là hai lượt nói, kể cả khi dòng trước chưa có dấu chấm. */
const MAX_CUE_GAP_MS = 2_000;

const NON_SPEECH = /[\[(（][^\])）]*[\])）]|♪[^♪]*♪|♪/g;
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co', 'no', 'vol', 'approx', 'e.g', 'i.e', 'u.s', 'u.k']);

function cleanCaptionText(text: string): string {
  return text
    .replace(/\n/g, ' ')
    .replace(NON_SPEECH, ' ')
    .replace(/^\s*(?:>>|-)\s*/, '')
    .replace(/\s+(?:>>|-)\s+(?=[A-Z])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventsOf(json: unknown): Json3Event[] {
  const events = (json as { events?: unknown })?.events;
  return Array.isArray(events) ? (events as Json3Event[]) : [];
}

/** Dòng phụ đề (người làm) đã làm sạch, theo thứ tự thời gian. */
export function parseManualCues(json: unknown): TimedText[] {
  const cues: TimedText[] = [];
  for (const event of eventsOf(json)) {
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
    const text = cleanCaptionText(event.segs.map(seg => seg.utf8 ?? '').join(''));
    if (!text) continue;
    const startMs = event.tStartMs as number;
    cues.push({ text, startMs, endMs: startMs + Math.max(0, event.dDurationMs ?? 0) });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** Vị trí kết thúc câu trong một dòng (sau dấu câu cuối câu), bỏ qua chữ viết tắt như "Mr." hay "U.S.". */
function sentenceBreaks(text: string): number[] {
  const breaks: number[] = [];
  const pattern = /[.?!…]+["'”’)\]]*(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    const word = /([A-Za-z.]+)$/.exec(before)?.[1]?.toLowerCase() ?? '';
    if (match[0].startsWith('.') && (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word))) continue;
    breaks.push(match.index + match[0].length);
  }
  return breaks;
}

interface Builder {
  parts: string[];
  startMs: number;
  endMs: number;
}

function toSegments(sentences: TimedText[], options: { prefix?: string; translated?: boolean } = {}): ScriptSegment[] {
  const used = new Set<string>();
  const prefix = options.prefix ?? 'cap';
  return sentences
    .filter(sentence => /[\p{L}\p{N}]/u.test(sentence.text))
    .map(sentence => {
      let segmentId = `${prefix}_${Math.round(sentence.startMs)}`;
      while (used.has(segmentId)) segmentId += 'b';
      used.add(segmentId);
      return {
        segmentId,
        text: sentence.text,
        startMs: Math.round(sentence.startMs),
        endMs: Math.round(Math.max(sentence.endMs, sentence.startMs + 300)),
        ...(options.translated ? { translatedText: sentence.text } : {})
      };
    });
}

/** Phụ đề tự động: từng từ kèm mốc bắt đầu (tStartMs của dòng + tOffsetMs của từ), theo thứ tự thời gian. */
export function parseAsrWords(json: unknown): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const event of eventsOf(json)) {
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
    for (const seg of event.segs as Array<Json3Seg & { tOffsetMs?: number }>) {
      const text = (seg.utf8 ?? '').trim();
      if (!text || text.length > 64) continue;
      words.push({ text, startMs: Math.round((event.tStartMs as number) + Math.max(0, seg.tOffsetMs ?? 0)) });
    }
  }
  return words.sort((a, b) => a.startMs - b.startMs);
}

/** Số từ tối đa mỗi lần gửi backend thêm dấu câu (khớp giới hạn của backend, ~10 phút lời nói). */
export const MAX_WORDS_PER_PUNCTUATE = 3_000;
/** Ranh giới giữa hai phần đặt ở khoảng ngừng dài nhất trong chừng này từ cuối phần, để ít cắt ngang câu. */
const CHUNK_BOUNDARY_SEARCH_WORDS = 200;
/** Phần đầu tiên (quanh vị trí đang xem) nhỏ hơn để bắt đầu đọc sớm. */
const FIRST_CHUNK_WORDS = 400;
/** Phần đầu tiên bắt đầu trước vị trí đang xem một chút để câu đang nói dở có đủ phần đầu. */
const FIRST_CHUNK_LEAD_MS = 15_000;

function chunkRange(words: CaptionWord[], from: number, to: number, maxWords: number): CaptionWord[][] {
  const chunks: CaptionWord[][] = [];
  let start = from;
  while (start < to) {
    let end = Math.min(to, start + maxWords);
    if (end < to) {
      let best = end;
      let bestGap = -1;
      for (let index = Math.max(start + 1, end - CHUNK_BOUNDARY_SEARCH_WORDS); index < end; index += 1) {
        const gap = words[index].startMs - words[index - 1].startMs;
        if (gap > bestGap) {
          bestGap = gap;
          best = index;
        }
      }
      end = best;
    }
    chunks.push(words.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Chia từ thành các phần gửi backend: phần chứa vị trí đang xem đi trước, rồi phần sau đó, cuối cùng phần trước đó (khi tua lại). */
export function chunkCaptionWords(
  words: CaptionWord[],
  positionMs: number,
  maxWords = MAX_WORDS_PER_PUNCTUATE,
  firstMaxWords = FIRST_CHUNK_WORDS
): CaptionWord[][] {
  if (words.length === 0) return [];
  let pivot = words.findIndex(word => word.startMs >= positionMs - FIRST_CHUNK_LEAD_MS);
  if (pivot < 0) pivot = Math.max(0, words.length - maxWords);
  // Lùi về khoảng ngừng dài nhất ngay trước mốc để không cắt ngang câu đang nói.
  let start = pivot;
  let bestGap = -1;
  for (let index = Math.max(1, pivot - 60); index <= pivot && index < words.length; index += 1) {
    const gap = words[index].startMs - words[index - 1].startMs;
    if (gap > bestGap) {
      bestGap = gap;
      start = index;
    }
  }
  if (pivot === 0) start = 0;
  // Phần đầu nhỏ để có câu sớm (thêm dấu câu 400 từ ~0.2 s thay vì ~1.5 s cho 3000 từ), các phần sau lớn.
  const [first = []] = chunkRange(words, start, words.length, Math.min(firstMaxWords, maxWords));
  return [first, ...chunkRange(words, start + first.length, words.length, maxWords), ...chunkRange(words, 0, start, maxWords)]
    .filter(chunk => chunk.length > 0);
}

/** Phụ đề người làm -> câu. */
export function buildManualScript(cues: TimedText[]): ScriptSegment[] {
  const sentences: TimedText[] = [];
  let current: Builder | null = null;
  const close = () => {
    if (current && current.parts.length > 0) sentences.push({ text: current.parts.join(' ').replace(/\s+/g, ' ').trim(), startMs: current.startMs, endMs: current.endMs });
    current = null;
  };
  for (const cue of cues) {
    if (current && (cue.startMs - (current as Builder).endMs > MAX_CUE_GAP_MS
      || cue.startMs - (current as Builder).startMs > MAX_SENTENCE_MS
      || (current as Builder).parts.join(' ').length > MAX_SENTENCE_CHARS)) close();
    const duration = Math.max(1, cue.endMs - cue.startMs);
    const breaks = sentenceBreaks(cue.text);
    let from = 0;
    for (const at of breaks.at(-1) === cue.text.length ? breaks : [...breaks, cue.text.length]) {
      const piece = cue.text.slice(from, at).trim();
      const pieceStart = cue.startMs + (duration * from) / cue.text.length;
      const pieceEnd = cue.startMs + (duration * at) / cue.text.length;
      const isSentenceEnd = breaks.includes(at);
      from = at;
      if (!piece) continue;
      current ??= { parts: [], startMs: pieceStart, endMs: pieceEnd };
      current.parts.push(piece);
      current.endMs = pieceEnd;
      if (isSentenceEnd) close();
    }
  }
  close();
  return toSegments(sentences);
}

export function buildCaptionScript(json: unknown): ScriptSegment[] {
  return buildManualScript(parseManualCues(json));
}

/** Người nói dừng chừng này (ms giữa hai từ) thì ngắt câu dù phụ đề không có dấu câu. */
const VI_PAUSE_MS = 1_500;
/** Sau dấu chấm/hỏi/than mà từ kế tiếp viết thường thì chỉ ngắt khi có khoảng lặng chừng này ("cách... ý tôi là" không ngắt). */
const VI_PUNCT_PAUSE_MS = 600;
/** Từ kế tiếp viết thường (câu chưa hết, dòng bị YouTube cắt) thì chỉ ngắt khi người nói dừng rất lâu. */
const VI_LONG_PAUSE_MS = 5_000;
const VI_WORD_TAIL_MS = 600;
/** Câu dài hơn (ms hoặc số từ) thì cắt ở dấu phẩy gần giữa câu nhất. */
const VI_MAX_SENTENCE_MS = 14_000;
const VI_MAX_SENTENCE_WORDS = 50;
const VI_MIN_PART_WORDS = 4;
const SENTENCE_END = /[.?!…]["'”’)\]]*$/;
/** "nó thực sự là..." thường là bỏ lửng giữa câu (YouTube vẫn viết hoa từ sau), chỉ là kết câu khi có khoảng lặng. */
const TRAILING_ELLIPSIS = /(?:\.\.\.|…)["'”’)\]]*$/;
const CLAUSE_END = /[,;:]["'”’)\]]*$/;
const STARTS_SENTENCE = /^["“'(]?[\p{Lu}\p{N}]/u;

function wordEndMs(words: CaptionWord[], index: number): number {
  const next = words[index + 1];
  return words[index].startMs + Math.min(VI_WORD_TAIL_MS, next ? Math.max(0, next.startMs - words[index].startMs) : VI_WORD_TAIL_MS);
}

/** Câu quá dài: cắt ở dấu phẩy gần giữa nhất (mỗi phần >= 4 từ), không có thì ở khoảng ngừng dài nhất. */
function splitLongSentence(words: CaptionWord[], all: CaptionWord[], offset: number): Array<[number, number]> {
  const from = offset;
  const to = offset + words.length - 1;
  const durationMs = wordEndMs(all, to) - all[from].startMs;
  if (durationMs <= VI_MAX_SENTENCE_MS && words.length <= VI_MAX_SENTENCE_WORDS) return [[from, to]];
  if (words.length < 2 * VI_MIN_PART_WORDS) return [[from, to]];
  const middle = from + words.length / 2;
  const candidates: number[] = [];
  for (let index = from + VI_MIN_PART_WORDS - 1; index <= to - VI_MIN_PART_WORDS; index += 1) {
    if (CLAUSE_END.test(all[index].text)) candidates.push(index);
  }
  let cut: number;
  if (candidates.length > 0) {
    cut = candidates.reduce((best, index) => (Math.abs(index + 1 - middle) < Math.abs(best + 1 - middle) ? index : best));
  } else {
    cut = from + VI_MIN_PART_WORDS - 1;
    for (let index = cut; index <= to - VI_MIN_PART_WORDS; index += 1) {
      if (all[index + 1].startMs - all[index].startMs > all[cut + 1].startMs - all[cut].startMs) cut = index;
    }
  }
  return [
    ...splitLongSentence(all.slice(from, cut + 1), all, from),
    ...splitLongSentence(all.slice(cut + 1, to + 1), all, cut + 1)
  ];
}

/**
 * Phụ đề tiếng Việt có mốc từng từ (bản dịch tự động của YouTube) -> câu đọc nguyên văn. Ngắt sau dấu kết câu khi từ kế tiếp viết hoa
 * (hoặc có khoảng lặng), hoặc khi người nói dừng lâu; ghép các dòng bị cắt giữa câu; câu quá dài cắt ở dấu phẩy.
 */
export function buildTimedWordScript(words: CaptionWord[]): ScriptSegment[] {
  const sentences: TimedText[] = [];
  let start = 0;
  for (let index = 0; index < words.length; index += 1) {
    const next = words[index + 1];
    const gapMs = next ? next.startMs - words[index].startMs : Number.POSITIVE_INFINITY;
    const text = words[index].text;
    const punctuated = TRAILING_ELLIPSIS.test(text)
      ? gapMs >= VI_PUNCT_PAUSE_MS
      : SENTENCE_END.test(text) && (!next || STARTS_SENTENCE.test(next.text) || gapMs >= VI_PUNCT_PAUSE_MS);
    // Ngừng lâu mà câu sau viết thường (dòng bị cắt giữa câu): vẫn là một câu, trừ khi ngừng rất lâu.
    const continues = next !== undefined && !STARTS_SENTENCE.test(next.text) && !CLAUSE_END.test(text);
    const paused = gapMs >= (continues ? VI_LONG_PAUSE_MS : VI_PAUSE_MS) && index - start + 1 >= 3;
    if (!punctuated && !paused && next) continue;
    for (const [from, to] of splitLongSentence(words.slice(start, index + 1), words, start)) {
      sentences.push({
        text: words.slice(from, to + 1).map(word => word.text).join(' '),
        startMs: words[from].startMs,
        endMs: wordEndMs(words, to)
      });
    }
    start = index + 1;
  }
  return toSegments(sentences, { prefix: 'yv', translated: true });
}

export type VietnameseTrackKind = 'manual' | 'auto';

/**
 * Phụ đề tiếng Việt của YouTube -> câu đọc nguyên văn. Rãnh do người làm (có dấu câu, dòng là câu/vế) ghép như phụ đề người làm;
 * bản dịch tự động có mốc từng từ thì ghép theo từ.
 */
export function buildVietnameseScript(json: unknown, kind: VietnameseTrackKind): ScriptSegment[] {
  if (kind === 'manual') return toSegments(buildManualScript(parseManualCues(json)).map(segment => ({ text: segment.text, startMs: segment.startMs, endMs: segment.endMs })), { prefix: 'yv', translated: true });
  return buildTimedWordScript(parseAsrWords(json));
}

/** Khung thời gian (ms video) giọng đọc của câu được dùng: từ lúc câu bắt đầu tới ngay trước lúc câu kế tiếp bắt đầu. */
export function segmentSlotMs(segments: ScriptSegment[], index: number): number {
  const segment = segments[index];
  const next = segments[index + 1];
  if (!next) return segment.endMs - segment.startMs + 1_500;
  return Math.max(300, next.startMs - segment.startMs - 100);
}
