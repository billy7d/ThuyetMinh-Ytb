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
/** Giọng tới muộn tới mức này (ms sau mốc bắt đầu) vẫn đọc từ đầu câu; muộn hơn thì đọc tiếp từ chỗ đúng với video. */
const MAX_LATE_RESTART_MS = 1_500;
const TICK_MS = 150;
const MIN_STRETCH_RATE = 1.02;
const STRETCH_BUDGET_MS = 600;

interface ReadyAudio {
  buffer: AudioBuffer;
  rate: number;
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
  private readonly segments: ScriptSegment[];
  private readonly indexById = new Map<string, number>();
  private readonly sent = new Set<string>();
  private readonly audio = new Map<string, ReadyAudio>();
  private readonly texts = new Map<string, string>();
  /** Câu đã phát (hoặc đã bỏ qua) trong lượt xem hiện tại. */
  private readonly handled = new Set<string>();
  private readonly voices: ScheduledVoice[] = [];
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
    for (const voice of this.voices.splice(0)) if (voice.endCtxTime > now) this.handled.delete(voice.segmentId);
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
    const decoded = await this.options.audioCtx.decodeAudioData(bytes.buffer);
    if (this.destroyed) return;
    // Co giãn sẵn (giữ cao độ) cho vừa khung tới câu kế tiếp; làm lúc nhận để lúc phát không tốn thời gian.
    const slotMs = segmentSlotMs(this.segments, index);
    const rate = Math.min(MAX_TTS_PLAYBACK_RATE, Math.max(1, (decoded.duration * 1000) / slotMs));
    let buffer = decoded;
    let stretchMs = 0;
    if (rate > MIN_STRETCH_RATE) {
      const startedAt = Date.now();
      try {
        buffer = stretchAudioBuffer(this.options.audioCtx, decoded, rate, STRETCH_BUDGET_MS);
      } catch {
        buffer = decoded;
      }
      stretchMs = Date.now() - startedAt;
    }
    this.audio.set(message.segmentId, { buffer, rate: buffer === decoded ? 1 : rate });
    emitDiagnostic(this.diagScope, 'audio_ready', {
      segmentId: message.segmentId,
      // Còn bao lâu nữa mới tới câu này (ms video); âm là giọng tới muộn.
      leadMs: this.segments[index].startMs - Math.round(this.options.video.currentTime * 1000),
      durationMs: Math.round(buffer.duration * 1000),
      slotMs: Math.round(slotMs),
      rate: Math.round(rate * 100) / 100,
      stretchMs
    });
    this.tick();
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
    for (const segment of this.segments) {
      if (segment.startMs > nowMs + SCRIPT_LOOKAHEAD_MS || batch.length >= SEND_BATCH) break;
      if (segment.endMs < nowMs - 1_000 || this.sent.has(segment.segmentId) || this.isComplete(segment.segmentId)) continue;
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
      } else if (lateMs > MAX_LATE_RESTART_MS) {
        this.handled.add(segment.segmentId);
      }
      return;
    }
    const ready = this.audio.get(segment.segmentId);
    if (!ready) {
      if (lateMs > MAX_LATE_RESTART_MS) {
        // Giọng không kịp: bỏ giọng câu này, vẫn hiện phụ đề nếu đã có bản dịch.
        this.handled.add(segment.segmentId);
        if (text && mode === 'dubbing_and_subtitle') this.showSubtitleLater(segment, text, 0, Math.max(800, segment.endMs - nowMs) / videoRate);
        emitDiagnostic(this.diagScope, 'audio_missed', { segmentId: segment.segmentId, lateMs: Math.round(lateMs) });
      }
      return;
    }
    // Muộn ít: đọc từ đầu câu (lệch nhẹ). Muộn nhiều (tiếp tục sau tạm dừng/tua vào giữa câu): đọc tiếp từ chỗ khớp với video.
    const offsetSec = lateMs > MAX_LATE_RESTART_MS ? (lateMs / 1000) : 0;
    this.handled.add(segment.segmentId);
    if (offsetSec >= ready.buffer.duration) return;
    const ctxNow = this.options.audioCtx.currentTime;
    // Câu trước còn đang đọc (giọng dài hơn khung dù đã tăng tốc tối đa): đọc nối tiếp, không chồng tiếng.
    const waitSec = Math.max(delaySec, this.lastVoiceEndCtxTime - ctxNow);
    const scheduled = this.options.mixer.scheduleTTSAt(ready.buffer, waitSec, offsetSec, videoRate);
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
      rate: Math.round(ready.rate * 100) / 100,
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
