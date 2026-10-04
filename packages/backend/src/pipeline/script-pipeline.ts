import {
  OperationMode,
  ScriptSegment,
  ServerMessage,
  SubtitleEventMessage,
  TTSChunkMessage,
  TranslationReadyMessage,
  emitDiagnostic
} from '@vietdub/shared';
import { TranslationEngine } from '../translation/translation-engine.js';
import { TTSProvider } from '../tts/types.js';
import { CostTracker } from '../cost/cost-tracker.js';

export interface ScriptPipelineContext {
  sessionId: string;
  sessionRef: string;
  translationEngine: TranslationEngine;
  ttsEngine: TTSProvider;
  costTracker: CostTracker;
  sendMessage(message: ServerMessage): void;
  getMode(): OperationMode;
  getGeneration(): number;
  isActive(): boolean;
  /** Lỗi không nghiêm trọng (pipeline chính tự giãn cách các cảnh báo lặp lại). */
  reportError(code: string, message: string): void;
}

/** Số câu tối đa chờ xử lý; extension chỉ gửi trước ~45 s nên vượt mức này là bất thường. */
const MAX_QUEUED_SEGMENTS = 200;

/**
 * Chế độ đọc trước theo phụ đề: nhận các câu đã có lời thoại và mốc thời gian (SCRIPT_SEGMENTS), dịch và tổng hợp
 * cả câu theo thứ tự, trả SUBTITLE_EVENT + TTS_CHUNK có `scheduled: true` để extension phát đúng lúc câu gốc bắt đầu.
 * Không dùng nhận dạng giọng nói, không giữ mảnh câu, không bỏ câu vì trễ: extension tự quyết định câu nào còn kịp phát.
 */
export class ScriptPipeline {
  private readonly queue: ScriptSegment[] = [];
  /** Câu đã nhận (đang chờ hoặc đã xong) trong lượt hiện tại; tua làm lượt mới nên xóa. */
  private readonly accepted = new Set<string>();
  private acceptedGeneration = 0;
  private running = false;

  constructor(private readonly context: ScriptPipelineContext) {}

  enqueue(segments: ScriptSegment[], generation: number): void {
    const currentGeneration = this.context.getGeneration();
    if (!this.context.isActive() || generation !== currentGeneration) {
      emitDiagnostic('script_pipeline', 'segments_stale', {
        sessionRef: this.context.sessionRef,
        generation,
        currentGeneration,
        count: segments.length
      });
      return;
    }
    if (this.acceptedGeneration !== generation) this.reset(generation);
    let added = 0;
    for (const segment of segments) {
      if (this.accepted.has(segment.segmentId) || this.queue.length >= MAX_QUEUED_SEGMENTS) continue;
      this.accepted.add(segment.segmentId);
      this.queue.push(segment);
      added++;
    }
    emitDiagnostic('script_pipeline', 'segments_enqueued', {
      sessionRef: this.context.sessionRef,
      generation,
      added,
      queued: this.queue.length
    });
    void this.pump();
  }

  /** Tua/dừng: bỏ các câu đang chờ của lượt cũ (câu đang xử lý tự bỏ khi thấy lượt đã đổi). */
  reset(generation = this.context.getGeneration()): void {
    this.queue.length = 0;
    this.accepted.clear();
    this.acceptedGeneration = generation;
  }

  private isCurrent(generation: number): boolean {
    return this.context.isActive() && generation === this.context.getGeneration();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && this.context.isActive()) {
        const segment = this.queue.shift() as ScriptSegment;
        const generation = this.acceptedGeneration;
        try {
          await this.process(segment, generation);
        } catch (error) {
          if (!this.isCurrent(generation)) continue;
          const message = error instanceof Error ? error.message : String(error);
          emitDiagnostic('script_pipeline', 'segment_failed', {
            sessionRef: this.context.sessionRef,
            segmentId: segment.segmentId,
            messageLength: message.length
          });
          if (!/contains no speech/i.test(message)) this.context.reportError('SCRIPT_SEGMENT_FAILED', message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async process(segment: ScriptSegment, generation: number): Promise<void> {
    const { translationEngine, ttsEngine, costTracker, sessionId, sessionRef } = this.context;
    const translationStartedAt = Date.now();
    const translation = await translationEngine.translateComplete(segment.text, segment.startMs, segment.endMs);
    const translationMs = Date.now() - translationStartedAt;
    if (!this.isCurrent(generation) || !translation.translatedText) return;
    costTracker.recordTranslation(segment.text.length);
    const text = translation.translatedText;
    const base = { sessionId, segmentId: segment.segmentId, startMs: segment.startMs, endMs: segment.endMs, generation };
    const translationReady: TranslationReadyMessage = {
      type: 'TRANSLATION_READY',
      timestamp: Date.now(),
      ...base,
      sourceText: segment.text,
      translatedText: text
    };
    this.context.sendMessage(translationReady);

    const mode = this.context.getMode();
    const subtitle = (ttsDurationMs?: number): SubtitleEventMessage => ({
      type: 'SUBTITLE_EVENT',
      timestamp: Date.now(),
      ...base,
      text,
      action: 'show',
      scheduled: true,
      ...(ttsDurationMs !== undefined ? { ttsDurationMs } : {})
    });
    if (mode === 'subtitle_only') {
      this.context.sendMessage(subtitle());
      emitDiagnostic('script_pipeline', 'segment_ready', { sessionRef, segmentId: segment.segmentId, translationMs, ttsMs: 0 });
      return;
    }

    const ttsStartedAt = Date.now();
    const tts = await ttsEngine.synthesize({ sessionId, segmentId: segment.segmentId, text, generation, startMs: segment.startMs, endMs: segment.endMs });
    const ttsMs = Date.now() - ttsStartedAt;
    if (!this.isCurrent(generation)) return;
    if (tts.cancelled || !tts.audioBase64) {
      // Không có giọng thì vẫn gửi phụ đề của câu.
      this.context.sendMessage(subtitle());
      return;
    }
    costTracker.recordTTS(text.length);
    this.context.sendMessage(subtitle(tts.durationMs));
    const chunk: TTSChunkMessage = {
      type: 'TTS_CHUNK',
      timestamp: Date.now(),
      ...base,
      audioBase64: tts.audioBase64,
      mimeType: tts.mimeType,
      sampleRate: tts.sampleRate,
      channels: tts.channels,
      durationMs: tts.durationMs,
      translatedText: text,
      scheduled: true
    };
    this.context.sendMessage(chunk);
    emitDiagnostic('script_pipeline', 'segment_ready', {
      sessionRef,
      segmentId: segment.segmentId,
      translationMs,
      ttsMs,
      durationMs: tts.durationMs,
      sourceDurationMs: segment.endMs - segment.startMs
    });
  }
}
