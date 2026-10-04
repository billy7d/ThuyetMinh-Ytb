/**
 * Đọc phụ đề YouTube do người làm (định dạng json3 của /api/timedtext) và ghép thành câu có mốc thời gian để thuyết minh trước:
 * tách câu theo dấu chấm/hỏi/than, một dòng chứa hai câu thì chia mốc theo số ký tự.
 * Phụ đề tự động (ASR) không dùng: không có dấu câu, ghép câu theo khoảng ngừng giữa các từ sai ranh giới câu
 * ("…one is the extraordinary." + "Evidence of human creativity…") nên bản dịch sai nghĩa; video đó dùng Whisper như cũ.
 */
import type { ScriptSegment } from '@vietdub/shared';

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

function toSegments(sentences: TimedText[]): ScriptSegment[] {
  const used = new Set<string>();
  return sentences
    .filter(sentence => /[A-Za-z0-9]/.test(sentence.text))
    .map(sentence => {
      let segmentId = `cap_${Math.round(sentence.startMs)}`;
      while (used.has(segmentId)) segmentId += 'b';
      used.add(segmentId);
      return { segmentId, text: sentence.text, startMs: Math.round(sentence.startMs), endMs: Math.round(Math.max(sentence.endMs, sentence.startMs + 300)) };
    });
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

/** Khung thời gian (ms video) giọng đọc của câu được dùng: từ lúc câu bắt đầu tới ngay trước lúc câu kế tiếp bắt đầu. */
export function segmentSlotMs(segments: ScriptSegment[], index: number): number {
  const segment = segments[index];
  const next = segments[index + 1];
  if (!next) return segment.endMs - segment.startMs + 1_500;
  return Math.max(300, next.startMs - segment.startMs - 100);
}
