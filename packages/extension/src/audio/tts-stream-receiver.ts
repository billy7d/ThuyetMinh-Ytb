import { TTSChunkMessage, emitDiagnostic } from '@vietdub/shared';
import type { TtsSubtitleSync } from '../sync/tts-subtitle-sync.js';
import { AudioMixer } from './mixer.js';
import { StreamingTimeStretcher } from './streaming-stretch.js';

/** Dưới ngưỡng này chênh lệch cao độ không nghe được, khỏi tốn công co giãn (cùng ngưỡng với mixer). */
const MIN_STRETCH_RATE = 1.02;
const MAX_OPEN_SEGMENTS = 8;

interface StreamSegment {
  dropped: boolean;
  rate: number;
  sampleRate: number;
  estimatedMs: number;
  stretcher: StreamingTimeStretcher | null;
  scheduledFirst: boolean;
  receivedSamples: number;
  stretchMs: number;
  pieces: number;
  /** Tổng khoảng trống nghe được giữa các đoạn của câu (đoạn tới muộn hơn lúc đoạn trước phát xong). */
  gapMs: number;
  maxGapMs: number;
}

export interface TtsStreamHost {
  audioCtx: Pick<AudioContext, 'createBuffer'>;
  mixer: AudioMixer;
  getSubtitleSync: () => TtsSubtitleSync | undefined;
  /** Nguồn phát mới nhất (để bộ đồng bộ video dừng được khi tạm dừng). */
  onSource?: (source: AudioBufferSourceNode) => void;
  /** Tiền tố diag: 'firefox_tts' | 'chrome_tts'. */
  diagScope: string;
}

/** PCM 16-bit little-endian (base64) -> Float32 [-1, 1]. */
export function decodePcm16(base64: string): Float32Array {
  const binary = atob(base64);
  const samples = binary.length >> 1;
  const out = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const value = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
    out[index] = (value > 32767 ? value - 65536 : value) / 32768;
  }
  return out;
}

/**
 * Nhận giọng đọc dạng luồng (TTS_CHUNK audio/pcm): ghép các đoạn thành một câu liền mạch.
 *
 * Tốc độ quyết định một lần ở đoạn đầu (thời lượng cả câu chỉ là ước tính từ backend). Nếu cần tăng tốc thì cả câu đi qua một bộ co giãn
 * giữ cao độ duy nhất nên không có lỗ hay lệch pha ở mối nối. Các đoạn xếp phát liền nhau theo thời gian mẫu chính xác, đồng bộ (không giải mã
 * bất đồng bộ) nên thứ tự luôn đúng. Phụ đề hiện khi đoạn đầu có tiếng, đủ lâu cho cả câu.
 */
export class TtsStreamReceiver {
  private readonly segments = new Map<string, StreamSegment>();
  private readonly detach: () => void;

  constructor(private readonly host: TtsStreamHost) {
    // Tua/tạm dừng/dừng phiên: bỏ hết câu đang nhận dở.
    this.detach = host.mixer.onTtsStopped(() => this.reset());
  }

  static handles(message: TTSChunkMessage): boolean {
    return message.mimeType === 'audio/pcm';
  }

  reset(): void {
    this.segments.clear();
  }

  destroy(): void {
    this.detach();
    this.segments.clear();
  }

  handle(message: TTSChunkMessage): void {
    const { mixer } = this.host;
    let segment = this.segments.get(message.segmentId);
    if (!segment) {
      if (message.partFinal) return;
      segment = this.openSegment(message);
      this.segments.set(message.segmentId, segment);
      while (this.segments.size > MAX_OPEN_SEGMENTS) {
        const oldest = this.segments.keys().next().value as string;
        this.segments.delete(oldest);
      }
    }
    if (segment.dropped) {
      if (message.partFinal) this.segments.delete(message.segmentId);
      return;
    }

    let output: Float32Array = new Float32Array(0);
    if (message.audioBase64) {
      const pcm = decodePcm16(message.audioBase64);
      segment.receivedSamples += pcm.length;
      segment.pieces += 1;
      if (segment.stretcher) {
        const startedAt = Date.now();
        output = segment.stretcher.push(pcm);
        segment.stretchMs += Date.now() - startedAt;
      } else {
        output = pcm;
      }
    }
    if (message.partFinal) {
      if (segment.stretcher) {
        const startedAt = Date.now();
        const tail = segment.stretcher.flush();
        segment.stretchMs += Date.now() - startedAt;
        output = concat(output, tail);
      }
    }
    if (output.length > 0) this.schedule(message, segment, output);
    if (message.partFinal) {
      emitDiagnostic(this.host.diagScope, 'stream_segment_done', {
        segmentId: message.segmentId,
        pieces: segment.pieces,
        estimatedMs: Math.round(segment.estimatedMs),
        actualMs: Math.round((segment.receivedSamples / segment.sampleRate) * 1000),
        rate: Math.round(segment.rate * 100) / 100,
        pitchPreserved: Boolean(segment.stretcher),
        stretchMs: segment.stretchMs,
        gapMs: segment.gapMs,
        maxGapMs: segment.maxGapMs
      });
      // Giọng đọc xong mà chưa từng có tiếng (đoạn quá ngắn): hiện phụ đề ngay.
      if (!segment.scheduledFirst) this.host.getSubtitleSync()?.ttsDropped(message.segmentId);
      this.segments.delete(message.segmentId);
    }
  }

  private openSegment(message: TTSChunkMessage): StreamSegment {
    const { mixer } = this.host;
    const sampleRate = message.sampleRate || 48_000;
    const estimatedMs = Math.max(1, message.totalDurationMs ?? message.durationMs);
    const segment: StreamSegment = {
      dropped: false,
      rate: 1,
      sampleRate,
      estimatedMs,
      stretcher: null,
      scheduledFirst: false,
      receivedSamples: 0,
      stretchMs: 0,
      pieces: 0,
      gapMs: 0,
      maxGapMs: 0
    };
    if (mixer.isTtsBacklogTooLong()) {
      // Bỏ giọng đọc của câu quá trễ là hành vi thiết kế (phụ đề câu đó vẫn hiện), giống đường không luồng.
      segment.dropped = true;
      this.host.getSubtitleSync()?.ttsDropped(message.segmentId);
      emitDiagnostic('tts_mixer', 'backlog_skipped', { backlogMs: mixer.getTTSBacklogMs(), segmentDurationMs: Math.round(estimatedMs), streaming: true });
      return segment;
    }
    segment.rate = mixer.chooseTtsRate(estimatedMs, message.endMs - message.startMs);
    if (segment.rate > MIN_STRETCH_RATE) {
      try {
        segment.stretcher = new StreamingTimeStretcher(sampleRate, segment.rate);
      } catch {
        // Không tạo được bộ co giãn: phát ở tốc độ 1.0 (câu dài hơn một chút còn hơn mất cao độ).
        segment.rate = 1;
      }
    }
    return segment;
  }

  private schedule(message: TTSChunkMessage, segment: StreamSegment, samples: Float32Array): void {
    const buffer = this.host.audioCtx.createBuffer(1, samples.length, segment.sampleRate);
    if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    else buffer.getChannelData(0).set(samples);
    const scheduled = this.host.mixer.scheduleStreamPiece(buffer);
    if (!scheduled) return;
    this.host.onSource?.(scheduled.source);
    if (segment.scheduledFirst && scheduled.lateByMs) {
      segment.gapMs += scheduled.lateByMs;
      segment.maxGapMs = Math.max(segment.maxGapMs, scheduled.lateByMs);
    }
    if (!segment.scheduledFirst) {
      segment.scheduledFirst = true;
      const total = Math.round(segment.estimatedMs / segment.rate);
      this.host.getSubtitleSync()?.ttsScheduled(message.segmentId, scheduled.delayMs, scheduled.durationMs, total);
      emitDiagnostic('tts_mixer', 'scheduled', {
        delayMs: scheduled.delayMs,
        durationMs: total,
        rate: Math.round(segment.rate * 100) / 100,
        pitchPreserved: Boolean(segment.stretcher),
        streaming: true
      });
    }
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
