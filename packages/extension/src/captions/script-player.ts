/**
 * Thuyết minh đọc trước theo phụ đề: giữ danh sách câu (mốc video), gửi trước các câu sắp tới cho backend dịch và tổng hợp,
 * nhận giọng đọc (TTS_CHUNK scheduled) rồi phát đúng lúc video tới mốc bắt đầu của câu thay vì sau khi câu gốc kết thúc.
 */
import { OperationMode, ScriptSegment, SubtitleEventMessage, TTSChunkMessage, emitDiagnostic } from '@vietdub/shared';
import { AudioMixer, MAX_TTS_PLAYBACK_RATE } from '../audio/mixer.js';
import { stretchAudioBuffer } from '../audio/time-stretch.js';
import { segmentSlotMs } from './caption-script.js';

/** Gửi trước các câu bắt đầu trong khoảng này (ms video) tính từ vị trí đang phát. */
export const SCRIPT_LOOKAHEAD_MS = 45_000;
const SEND_BATCH = 24;
/** Lên lịch câu sắp tới sớm chừng này (ms) để AudioContext phát đúng mốc. */
const SCHEDULE_AHEAD_MS = 400;
/** Câu chưa có giọng: bỏ giọng khi phần còn lại của khung ngắn hơn chừng này (ms), vì có tới cũng không kịp đọc. */
const MIN_REMAINING_SLOT_MS = 800;
/** Chỉ phụ đề: câu chưa có bản dịch khi đã muộn quá chừng này thì bỏ. */
const MAX_LATE_SUBTITLE_MS = 1_500;
const TICK_MS = 150;
const MIN_STRETCH_RATE = 1.02;
const STRETCH_BUDGET_MS = 600;
/**
 * Thời gian cần để dịch + tổng hợp một câu: ~1 s cộng 35% độ dài câu gốc (giọng Trúc Ly dài ~0.8 lần câu gốc, GPU RTF ~0.38).
 * Ước dư quá thì câu ngay sau lúc bấm Bắt đầu bị bỏ oan (giọng đầu tiên chờ tới câu thứ ba).
 */
const MIN_DUB_PREP_MS = 1_000;
const DUB_PREP_PER_SOURCE_MS = 0.35;
const MIN_SUBTITLE_PREP_MS = 400;

interface ReadyAudio {
  /** Đã co giãn sẵn theo khung danh nghĩa của câu. */
  buffer: AudioBuffer;
  rate: number;
  /** Bản đã cắt im lặng, chưa co giãn: co giãn lại nhanh hơn khi câu phải bắt đầu muộn. */
  source: AudioBuffer;
}

/** Giữ lại chừng này im lặng ở đầu/cuối câu sau khi cắt (giây): đủ để giọng không bị cụt. */
const KEEP_HEAD_SEC = 0.04;
const KEEP_TAIL_SEC = 0.1;
const SILENCE_RMS = 0.01;

/**
 * Cắt im lặng đầu/cuối câu của giọng đọc (VieNeu thường để ~0.2-0.4 s mỗi đầu). Im lặng đó làm giọng bắt đầu muộn hơn câu gốc
 * và làm câu dài hơn khung, đẩy câu sau muộn theo.
 */
export function trimSilence(context: Pick<BaseAudioContext, 'createBuffer'>, buffer: AudioBuffer): AudioBuffer {
  const data = new Float32Array(buffer.length);
  if (typeof buffer.copyFromChannel === 'function') buffer.copyFromChannel(data, 0);
  else data.set(buffer.getChannelData(0));
  const frame = Math.max(1, Math.round(buffer.sampleRate * 0.01));
  const voiced = (from: number): boolean => {
    let sum = 0;
    const to = Math.min(data.length, from + frame);
    for (let index = from; index < to; index += 1) sum += data[index] * data[index];
    return Math.sqrt(sum / Math.max(1, to - from)) > SILENCE_RMS;
  };
  let first = 0;
  while (first < data.length && !voiced(first)) first += frame;
  let last = Math.floor((data.length - 1) / frame) * frame;
  while (last > first && !voiced(last)) last -= frame;
  if (first >= data.length) return buffer;
  const start = Math.max(0, first - Math.round(KEEP_HEAD_SEC * buffer.sampleRate));
  const end = Math.min(buffer.length, last + frame + Math.round(KEEP_TAIL_SEC * buffer.sampleRate));
  if (start === 0 && end === buffer.length) return buffer;
  const trimmed = context.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = channel === 0 ? data : new Float32Array(buffer.length);
    if (channel > 0) {
      if (typeof buffer.copyFromChannel === 'function') buffer.copyFromChannel(source, channel);
      else source.set(buffer.getChannelData(channel));
    }
    const part = source.subarray(start, end);
    if (typeof trimmed.copyToChannel === 'function') trimmed.copyToChannel(part as Float32Array<ArrayBuffer>, channel);
    else trimmed.getChannelData(channel).set(part);
  }
  return trimmed;
}

interface ScheduledVoice {
  segmentId: string;
  endCtxTime: number;
}

export interface ScriptPlayerOptions {
  video: HTMLVideoElement;
  audioCtx: BaseAudioContext;
  mixer: AudioMixer;
  segments: ScriptSegment[];
  getMode(): OperationMode;
  /** Gửi SCRIPT_SEGMENTS cho backend. */
  send(segments: ScriptSegment[]): void;
  showSubtitle(segment: ScriptSegment, text: string, durationMs: number): void;
  onSource?(source: AudioBufferSourceNode): void;
  diagScope?: string;
}

export class ScriptDubPlayer {
  private segments: ScriptSegment[];
  private readonly indexById = new Map<string, number>();
  private readonly sent = new Set<string>();
  private readonly audio = new Map<string, ReadyAudio>();
  private readonly texts = new Map<string, string>();
  /** Câu đã phát (hoặc đã bỏ qua) trong lượt xem hiện tại. */
  private readonly handled = new Set<string>();
  private readonly voices: ScheduledVoice[] = [];
  /** Câu đang đọc dở thì bị tạm dừng: phát lại thì đọc tiếp đúng chỗ, không đọc lại từ đầu. */
  private readonly interrupted = new Set<string>();
  private readonly subtitleTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastVoiceEndCtxTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly diagScope: string;

  constructor(private readonly options: ScriptPlayerOptions) {
    this.segments = [...options.segments].sort((a, b) => a.startMs - b.startMs);
    this.segments.forEach((segment, index) => this.indexById.set(segment.segmentId, index));
    this.diagScope = options.diagScope ?? 'script_dub';
  }

  /** Phụ đề tự động: câu của các phần sau được thêm dần khi backend thêm dấu câu xong. */
  addSegments(segments: ScriptSegment[]): void {
    const fresh = segments.filter(segment => !this.indexById.has(segment.segmentId));
    if (fresh.length === 0) return;
    this.segments = [...this.segments, ...fresh].sort((a, b) => a.startMs - b.startMs);
    this.indexById.clear();
    this.segments.forEach((segment, index) => this.indexById.set(segment.segmentId, index));
    this.tick();
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  start(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearSubtitleTimers();
  }

  owns(segmentId: string): boolean {
    return this.indexById.has(segmentId);
  }

  /** Tua: câu từ vị trí mới phát lại được; giọng đã có dùng lại, câu chưa xong thì gửi lại (backend đã bỏ việc của lượt cũ). */
  handleSeek(): void {
    this.handled.clear();
    this.voices.length = 0;
    this.lastVoiceEndCtxTime = 0;
    this.clearSubtitleTimers();
    for (const segmentId of [...this.sent]) if (!this.isComplete(segmentId)) this.sent.delete(segmentId);
    this.tick();
  }

  /** Tạm dừng (giọng đọc đã bị dừng): câu đang đọc dở sẽ đọc tiếp đúng chỗ khi video phát lại. */
  handlePause(): void {
    const now = this.options.audioCtx.currentTime;
    for (const voice of this.voices.splice(0)) {
      if (voice.endCtxTime <= now) continue;
      this.handled.delete(voice.segmentId);
      this.interrupted.add(voice.segmentId);
    }
    this.lastVoiceEndCtxTime = 0;
    this.clearSubtitleTimers();
  }

  handleSubtitle(message: SubtitleEventMessage): void {
    if (this.owns(message.segmentId) && message.text) this.texts.set(message.segmentId, message.text);
  }

  async handleTts(message: TTSChunkMessage): Promise<void> {
    const index = this.indexById.get(message.segmentId);
    if (index === undefined || !message.audioBase64) return;
    if (message.translatedText) this.texts.set(message.segmentId, message.translatedText);
    const binary = atob(message.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const raw = await this.options.audioCtx.decodeAudioData(bytes.buffer);
    if (this.destroyed) return;
    const decoded = trimSilence(this.options.audioCtx, raw);
    // Co giãn sẵn (giữ cao độ) cho vừa khung tới câu kế tiếp; làm lúc nhận để lúc phát không tốn thời gian.
    const slotMs = segmentSlotMs(this.segments, index);
    const rate = Math.min(MAX_TTS_PLAYBACK_RATE, Math.max(1, (decoded.duration * 1000) / slotMs));
    const startedAt = Date.now();
    const buffer = this.stretch(decoded, rate);
    const stretchMs = Date.now() - startedAt;
    this.audio.set(message.segmentId, { buffer, rate: buffer === decoded ? 1 : rate, source: decoded });
    emitDiagnostic(this.diagScope, 'audio_ready', {
      segmentId: message.segmentId,
      // Còn bao lâu nữa mới tới câu này (ms video); âm là giọng tới muộn.
      leadMs: this.segments[index].startMs - Math.round(this.options.video.currentTime * 1000),
      durationMs: Math.round(buffer.duration * 1000),
      trimmedMs: Math.round((raw.duration - decoded.duration) * 1000),
      slotMs: Math.round(slotMs),
      rate: Math.round(rate * 100) / 100,
      stretchMs
    });
    this.tick();
  }

  private stretch(buffer: AudioBuffer, rate: number): AudioBuffer {
    if (rate <= MIN_STRETCH_RATE) return buffer;
    try {
      return stretchAudioBuffer(this.options.audioCtx, buffer, rate, STRETCH_BUDGET_MS);
    } catch {
      return buffer;
    }
  }

  private isComplete(segmentId: string): boolean {
    return this.options.getMode() === 'subtitle_only' ? this.texts.has(segmentId) : this.audio.has(segmentId);
  }

  private tick(): void {
    if (this.destroyed) return;
    const video = this.options.video;
    const nowMs = video.currentTime * 1000;
    this.sendUpcoming(nowMs);
    if (video.paused || video.seeking || video.ended) return;
    for (let index = 0; index < this.segments.length; index += 1) {
      const segment = this.segments[index];
      if (segment.startMs > nowMs + SCHEDULE_AHEAD_MS) break;
      if (this.handled.has(segment.segmentId)) continue;
      const passedAtMs = segment.startMs + Math.max(segmentSlotMs(this.segments, index), segment.endMs - segment.startMs);
      if (nowMs >= passedAtMs) {
        this.handled.add(segment.segmentId);
        continue;
      }
      this.play(segment, index, nowMs);
    }
  }

  private sendUpcoming(nowMs: number): void {
    const batch: ScriptSegment[] = [];
    const playing = !this.options.video.paused;
    const subtitleOnly = this.options.getMode() === 'subtitle_only';
    for (const segment of this.segments) {
      if (segment.startMs > nowMs + SCRIPT_LOOKAHEAD_MS || batch.length >= SEND_BATCH) break;
      if (segment.endMs < nowMs - 1_000 || this.sent.has(segment.segmentId) || this.isComplete(segment.segmentId)) continue;
      // Đang phát mà câu bắt đầu quá sớm để kịp dịch + đọc: không gửi, để backend dồn sức cho các câu sau (nếu không, mọi câu
      // phía sau đều muộn theo). Lúc tạm dừng thì chuẩn bị hết.
      const prepMs = subtitleOnly ? MIN_SUBTITLE_PREP_MS : MIN_DUB_PREP_MS + DUB_PREP_PER_SOURCE_MS * (segment.endMs - segment.startMs);
      if (playing && segment.startMs < nowMs + prepMs) continue;
      batch.push(segment);
    }
    if (batch.length === 0) return;
    for (const segment of batch) this.sent.add(segment.segmentId);
    this.options.send(batch);
  }

  private play(segment: ScriptSegment, index: number, nowMs: number): void {
    const lateMs = nowMs - segment.startMs;
    const mode = this.options.getMode();
    const text = this.texts.get(segment.segmentId);
    const videoRate = this.options.video.playbackRate > 0 ? this.options.video.playbackRate : 1;
    const delaySec = Math.max(0, -lateMs) / 1000 / videoRate;
    if (mode === 'subtitle_only') {
      if (text) {
        this.handled.add(segment.segmentId);
        this.showSubtitleLater(segment, text, delaySec, segmentSlotMs(this.segments, index) / videoRate);
      } else if (lateMs > MAX_LATE_SUBTITLE_MS) {
        this.handled.add(segment.segmentId);
      }
      return;
    }
    const slotMs = segmentSlotMs(this.segments, index);
    const ready = this.audio.get(segment.segmentId);
    if (!ready) {
      if (lateMs > slotMs - MIN_REMAINING_SLOT_MS) {
        // Giọng không kịp: bỏ giọng câu này, vẫn hiện phụ đề nếu đã có bản dịch.
        this.handled.add(segment.segmentId);
        if (text && mode === 'dubbing_and_subtitle') this.showSubtitleLater(segment, text, 0, Math.max(800, segment.endMs - nowMs) / videoRate);
        emitDiagnostic(this.diagScope, 'audio_missed', { segmentId: segment.segmentId, lateMs: Math.round(lateMs) });
      }
      return;
    }
    // Muộn mà phần còn lại của khung (ở tốc độ tối đa) vẫn chứa đủ cả câu: đọc từ đầu rồi bắt kịp (co giãn bên dưới), không cắt mất
    // đầu câu. Không đủ, hoặc phát tiếp sau tạm dừng: đọc tiếp từ chỗ khớp với video.
    const resumed = this.interrupted.delete(segment.segmentId);
    const remainingSec = (slotMs - Math.max(0, lateMs)) / 1000;
    const fitsFromStart = remainingSec * MAX_TTS_PLAYBACK_RATE >= ready.source.duration;
    const offsetSec = lateMs > 0 && (resumed || !fitsFromStart) ? lateMs / 1000 : 0;
    this.handled.add(segment.segmentId);
    if (offsetSec >= ready.buffer.duration) return;
    const ctxNow = this.options.audioCtx.currentTime;
    // Câu trước còn đang đọc (giọng dài hơn khung dù đã tăng tốc tối đa): đọc nối tiếp, không chồng tiếng.
    const waitSec = Math.max(delaySec, this.lastVoiceEndCtxTime - ctxNow);
    let playable = ready.buffer;
    let catchUpRate = ready.rate;
    // Bắt đầu muộn (chờ câu trước hoặc giọng tới muộn): thời gian còn lại tới câu sau ngắn hơn khung danh nghĩa, co giãn lại
    // nhanh hơn (trong trần tốc độ) để không đẩy câu sau muộn theo; nếu không, độ trễ cộng dồn suốt đoạn nói liên tục.
    const lateStartSec = offsetSec > 0 ? 0 : Math.max(0, lateMs) / 1000 + (waitSec - delaySec) * videoRate;
    const next = this.segments[index + 1];
    if (lateStartSec > 0.05 && next && ready.rate < MAX_TTS_PLAYBACK_RATE) {
      const availableSec = Math.max(0.3, (next.startMs - segment.startMs) / 1000 - lateStartSec - 0.1);
      const needed = Math.min(MAX_TTS_PLAYBACK_RATE, ready.source.duration / availableSec);
      if (needed > ready.rate + 0.03) {
        playable = this.stretch(ready.source, needed);
        catchUpRate = playable === ready.source ? 1 : needed;
      }
    }
    const scheduled = this.options.mixer.scheduleTTSAt(playable, waitSec, offsetSec, videoRate);
    if (!scheduled) return;
    const endCtxTime = ctxNow + waitSec + scheduled.durationMs / 1000;
    this.lastVoiceEndCtxTime = endCtxTime;
    this.voices.push({ segmentId: segment.segmentId, endCtxTime });
    if (this.voices.length > 16) this.voices.shift();
    this.options.onSource?.(scheduled.source);
    if (text && mode === 'dubbing_and_subtitle') this.showSubtitleLater(segment, text, waitSec, scheduled.durationMs);
    emitDiagnostic(this.diagScope, 'scheduled', {
      segmentId: segment.segmentId,
      // Giọng bắt đầu lệch bao nhiêu so với câu gốc (ms video, dương là muộn).
      startOffsetMs: Math.round(Math.max(0, lateMs) - offsetSec * 1000 + (waitSec - delaySec) * 1000 * videoRate),
      offsetMs: Math.round(offsetSec * 1000),
      durationMs: scheduled.durationMs,
      rate: Math.round(catchUpRate * 100) / 100,
      catchUp: catchUpRate > ready.rate,
      videoRate
    });
  }

  private showSubtitleLater(segment: ScriptSegment, text: string, delaySec: number, durationMs: number): void {
    const show = () => this.options.showSubtitle(segment, text, Math.max(800, Math.round(durationMs)));
    if (delaySec <= 0.02) {
      show();
      return;
    }
    const timer = setTimeout(() => {
      this.subtitleTimers.delete(timer);
      if (!this.destroyed) show();
    }, delaySec * 1000);
    this.subtitleTimers.add(timer);
  }

  private clearSubtitleTimers(): void {
    for (const timer of this.subtitleTimers) clearTimeout(timer);
    this.subtitleTimers.clear();
  }
}
