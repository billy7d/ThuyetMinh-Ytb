import { AudioMixerConfig, DEFAULT_ORIGINAL_VOLUME, DEFAULT_TTS_VOLUME, emitDiagnostic } from '@vietdub/shared';
import { stretchAudioBuffer } from './time-stretch.js';

export type AudioSourceMode = 'media-element' | 'capture-stream' | 'media-stream';

export interface AudioMixerOptions {
  sourceMode?: AudioSourceMode;
  videoElement?: HTMLMediaElement;
  initialConfig?: Partial<AudioMixerConfig>;
}

/**
 * Hàng chờ phát TTS tối đa trước khi bỏ câu mới (ms). Mỗi giây chờ là một giây thuyết minh (và phụ đề
 * đồng bộ theo nó) trễ thêm so với video, nên giữ ngắn.
 */
export const DEFAULT_MAX_TTS_BACKLOG_MS = 3_500;

export interface ScheduledTTS {
  source: AudioBufferSourceNode;
  /** Thời gian chờ tới khi câu bắt đầu phát (ms). */
  delayMs: number;
  /** Thời lượng phát thực tế sau khi tính tốc độ (ms). */
  durationMs: number;
  /** Chỉ giọng đọc dạng luồng: đoạn tới trễ bao lâu so với lúc đoạn trước phát xong (ms). */
  lateByMs?: number;
}
/** Tốc độ phát tối đa; cao hơn mức này giọng đọc bị nuốt âm khó nghe (đã co giãn giữ cao độ, xem time-stretch.ts). */
export const MAX_TTS_PLAYBACK_RATE = 1.3;
/** Dưới ngưỡng này chênh lệch cao độ không nghe được, khỏi tốn công co giãn. */
const MIN_STRETCH_RATE = 1.02;

/**
 * Tốc độ phát TTS theo độ dài hàng chờ: 1.0 khi không trễ, tăng dần từ 0.5 s tới trần 1.3 khi trễ ~3 s.
 * Tăng tốc sớm giữ hàng chờ khỏi đầy tới mức phải bỏ cả câu thuyết minh.
 */
export function ttsPlaybackRateForBacklog(backlogMs: number): number {
  if (!Number.isFinite(backlogMs) || backlogMs <= 500) return 1;
  return Math.min(MAX_TTS_PLAYBACK_RATE, 1 + (backlogMs - 500) / 8_000);
}

/**
 * Tốc độ để giọng đọc vừa khung thời gian của câu gốc (cộng 0.6 s nghỉ). Giọng tiếng Việt dài hơn lời gốc
 * mà phát ở 1.0x thì mỗi câu đẩy câu sau trễ thêm, thuyết minh (và phụ đề đồng bộ) trôi dần khỏi video.
 */
export function ttsPlaybackRateForSlot(audioDurationMs: number, sourceDurationMs: number | undefined): number {
  if (!Number.isFinite(audioDurationMs) || !Number.isFinite(sourceDurationMs) || (sourceDurationMs as number) <= 0) return 1;
  const slotMs = (sourceDurationMs as number) + 600;
  if (audioDurationMs <= slotMs) return 1;
  return Math.min(MAX_TTS_PLAYBACK_RATE, audioDurationMs / slotMs);
}

interface SavedVideoAudioState {
  volume: number;
  muted: boolean;
}

export class AudioMixer {
  private readonly audioCtx: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode;
  private readonly sourceMode: AudioSourceMode;
  private readonly videoElement: HTMLMediaElement | null;
  private readonly savedVideoAudioState: SavedVideoAudioState | null;
  private readonly originalGainNode: GainNode;
  private readonly ttsGainNode: GainNode;
  private readonly sttTapNode: GainNode;
  private readonly ttsSources = new Set<AudioBufferSourceNode>();
  private nextTTSStartTime = 0;
  private disconnected = false;
  private readonly ttsStopListeners = new Set<() => void>();

  private config: AudioMixerConfig = {
    originalVolume: DEFAULT_ORIGINAL_VOLUME,
    originalMuted: false,
    ttsVolume: DEFAULT_TTS_VOLUME
  };

  constructor(
    audioCtx: AudioContext,
    sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode,
    options: AudioMixerOptions = {}
  ) {
    this.audioCtx = audioCtx;
    this.sourceNode = sourceNode;
    this.sourceMode = options.sourceMode || 'media-stream';
    this.videoElement = options.videoElement || null;
    this.savedVideoAudioState = this.videoElement
      ? { volume: this.videoElement.volume, muted: this.videoElement.muted }
      : null;
    this.config = { ...this.config, ...options.initialConfig };

    this.originalGainNode = audioCtx.createGain();
    this.ttsGainNode = audioCtx.createGain();
    this.sttTapNode = audioCtx.createGain();

    this.setupGraph();
    this.applyConfig();
  }

  private setupGraph(): void {
    // Nhánh STT luôn lấy tín hiệu trước khi giảm âm thanh gốc.
    this.sourceNode.connect(this.sttTapNode);

    // MediaElementSource đã tiếp quản đường phát của video; capture stream thì không.
    if (this.sourceMode !== 'capture-stream') {
      this.sourceNode.connect(this.originalGainNode);
      this.originalGainNode.connect(this.audioCtx.destination);
    }

    // TTS là nhánh độc lập, không phụ thuộc volume/mute của video.
    this.ttsGainNode.connect(this.audioCtx.destination);
  }

  /**
   * Thay nguồn thu (chỉ chế độ capture-stream): khi trang đổi nguồn phát (YouTube chèn quảng cáo, nạp lại
   * MediaSource…), track cũ của captureStream chết và chỉ còn trả về im lặng.
   */
  replaceCaptureSource(sourceNode: MediaStreamAudioSourceNode): void {
    if (this.disconnected || this.sourceMode !== 'capture-stream') return;
    try {
      this.sourceNode.disconnect();
    } catch {
      // Nút cũ đã bị ngắt.
    }
    this.sourceNode = sourceNode;
    this.sourceNode.connect(this.sttTapNode);
  }

  getSTTTapNode(): GainNode {
    return this.sttTapNode;
  }

  getTTSDestination(): GainNode {
    return this.ttsGainNode;
  }

  setOriginalVolume(volumePercent: number): void {
    this.config.originalVolume = this.clampPercent(volumePercent);
    this.applyConfig();
  }

  setOriginalMuted(muted: boolean): void {
    this.config.originalMuted = muted;
    this.applyConfig();
  }

  setTTSVolume(volumePercent: number): void {
    this.config.ttsVolume = this.clampPercent(volumePercent);
    this.applyConfig();
  }

  getConfig(): AudioMixerConfig {
    return { ...this.config };
  }

  private applyConfig(): void {
    const originalGain = this.config.originalMuted ? 0 : this.config.originalVolume / 100;

    if (this.sourceMode === 'capture-stream' && this.videoElement && this.savedVideoAudioState) {
      // captureStream không điều khiển đường loa trực tiếp, vì vậy chỉ scale volume gốc.
      this.videoElement.volume = Math.max(0, Math.min(1, this.savedVideoAudioState.volume * originalGain));
    } else {
      this.originalGainNode.gain.setValueAtTime(originalGain, this.audioCtx.currentTime);
    }

    this.ttsGainNode.gain.setValueAtTime(this.config.ttsVolume / 100, this.audioCtx.currentTime);
  }

  private clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  }

  /**
   * Phát một AudioBuffer trên nhánh TTS độc lập, nối tiếp câu trước.
   * Nếu hàng chờ phát đã dài hơn maxBacklogMs thì bỏ câu mới (trả về null) để thuyết minh không trễ dồn.
   */
  playTTSBuffer(audioBuffer: AudioBuffer, maxBacklogMs = DEFAULT_MAX_TTS_BACKLOG_MS): AudioBufferSourceNode | null {
    return this.scheduleTTSBuffer(audioBuffer, maxBacklogMs)?.source ?? null;
  }

  /** Như playTTSBuffer nhưng trả về thời điểm bắt đầu/thời lượng để hiển thị phụ đề đúng lúc giọng đọc. */
  scheduleTTSBuffer(
    audioBuffer: AudioBuffer,
    maxBacklogMs = DEFAULT_MAX_TTS_BACKLOG_MS,
    sourceDurationMs?: number
  ): ScheduledTTS | null {
    if (this.disconnected) return null;
    if (this.getTTSBacklogMs() > maxBacklogMs) {
      // Bỏ giọng đọc của câu quá trễ là hành vi thiết kế (phụ đề câu đó vẫn hiện), không phải lỗi: chỉ ghi chẩn đoán.
      emitDiagnostic('tts_mixer', 'backlog_skipped', {
        backlogMs: this.getTTSBacklogMs(),
        limitMs: maxBacklogMs,
        segmentDurationMs: Math.round(audioBuffer.duration * 1000)
      });
      return null;
    }
    const source = this.audioCtx.createBufferSource();
    // Câu tiếng Việt thường dài hơn câu gốc; khi bắt đầu trễ thì phát nhanh hơn một chút để bắt kịp video.
    const requestedRate = Math.max(
      ttsPlaybackRateForBacklog(this.getTTSBacklogMs()),
      ttsPlaybackRateForSlot(audioBuffer.duration * 1000, sourceDurationMs)
    );
    // Rút ngắn bằng co giãn thời gian giữ cao độ; playbackRate của nguồn phát đổi cả cao độ (giọng the thé như hoạt hình).
    const stretchStartedAt = Date.now();
    const stretched = requestedRate > MIN_STRETCH_RATE ? this.tryStretch(audioBuffer, requestedRate) : null;
    const stretchMs = Date.now() - stretchStartedAt;
    const playable = stretched ?? audioBuffer;
    const rate = stretched ? 1 : requestedRate;
    source.buffer = playable;
    if (source.playbackRate) source.playbackRate.value = rate;
    source.connect(this.ttsGainNode);
    this.ttsSources.add(source);
    source.onended = () => this.ttsSources.delete(source);
    const startAt = Math.max(this.audioCtx.currentTime, this.nextTTSStartTime);
    source.start(startAt);
    this.nextTTSStartTime = startAt + playable.duration / rate;
    const delayMs = Math.max(0, Math.round((startAt - this.audioCtx.currentTime) * 1000));
    const durationMs = Math.round((playable.duration / rate) * 1000);
    // AudioContext bị trình duyệt tạm dừng (chính sách autoplay) thì câu được lên lịch nhưng không phát ra loa.
    emitDiagnostic('tts_mixer', 'scheduled', {
      contextState: this.audioCtx.state,
      delayMs,
      durationMs,
      rate: Math.round(requestedRate * 100) / 100,
      pitchPreserved: Boolean(stretched),
      stretchMs,
      ttsGain: Math.round(this.config.ttsVolume)
    });
    return { source, delayMs, durationMs };
  }

  /** Co giãn giữ cao độ; null nếu môi trường không hỗ trợ hoặc lỗi (khi đó dùng playbackRate như trước). */
  private tryStretch(audioBuffer: AudioBuffer, rate: number): AudioBuffer | null {
    if (typeof audioBuffer.getChannelData !== 'function' || typeof this.audioCtx.createBuffer !== 'function') return null;
    try {
      return stretchAudioBuffer(this.audioCtx, audioBuffer, rate);
    } catch {
      return null;
    }
  }

  /** Nghe sự kiện dừng toàn bộ giọng đọc (tua, tạm dừng, dừng phiên) để các bộ nhận giọng đọc dạng luồng dọn trạng thái. */
  onTtsStopped(listener: () => void): () => void {
    this.ttsStopListeners.add(listener);
    return () => this.ttsStopListeners.delete(listener);
  }

  /** Hàng chờ phát đã dài tới mức nên bỏ giọng đọc của câu mới (phụ đề câu đó vẫn hiện). */
  isTtsBacklogTooLong(maxBacklogMs = DEFAULT_MAX_TTS_BACKLOG_MS): boolean {
    return this.getTTSBacklogMs() > maxBacklogMs;
  }

  /**
   * Tốc độ cho cả câu đọc dạng luồng, quyết định một lần ở đoạn đầu (chưa biết câu dài bao nhiêu nên dùng thời lượng ước tính):
   * lớn hơn của tốc độ theo hàng chờ và tốc độ để vừa khung thời gian câu gốc.
   */
  /**
   * Chế độ đọc trước theo phụ đề: phát buffer (đã co giãn sẵn) sau `delaySec` giây, bắt đầu từ `offsetSec` trong buffer
   * (tiếp tục câu giữa chừng sau khi tạm dừng/tua). Không qua hàng chờ: thời điểm phát do mốc trên video quyết định.
   */
  scheduleTTSAt(audioBuffer: AudioBuffer, delaySec: number, offsetSec = 0, playbackRate = 1): ScheduledTTS | null {
    if (this.disconnected || offsetSec >= audioBuffer.duration) return null;
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    if (source.playbackRate) source.playbackRate.value = playbackRate;
    source.connect(this.ttsGainNode);
    this.ttsSources.add(source);
    source.onended = () => this.ttsSources.delete(source);
    const startAt = this.audioCtx.currentTime + Math.max(0, delaySec);
    source.start(startAt, Math.max(0, offsetSec));
    const durationSec = (audioBuffer.duration - Math.max(0, offsetSec)) / playbackRate;
    this.nextTTSStartTime = Math.max(this.nextTTSStartTime, startAt + durationSec);
    return { source, delayMs: Math.round(Math.max(0, delaySec) * 1000), durationMs: Math.round(durationSec * 1000) };
  }

  chooseTtsRate(estimatedAudioMs: number, sourceDurationMs: number | undefined): number {
    return Math.max(ttsPlaybackRateForBacklog(this.getTTSBacklogMs()), ttsPlaybackRateForSlot(estimatedAudioMs, sourceDurationMs));
  }

  /** Xếp một đoạn giọng đọc dạng luồng (đã co giãn nếu cần) phát liền ngay sau đoạn trước, ở tốc độ 1.0. */
  scheduleStreamPiece(audioBuffer: AudioBuffer): ScheduledTTS | null {
    if (this.disconnected) return null;
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    if (source.playbackRate) source.playbackRate.value = 1;
    source.connect(this.ttsGainNode);
    this.ttsSources.add(source);
    source.onended = () => this.ttsSources.delete(source);
    const expectedStart = this.nextTTSStartTime;
    const startAt = Math.max(this.audioCtx.currentTime, expectedStart);
    source.start(startAt);
    this.nextTTSStartTime = startAt + audioBuffer.duration;
    return {
      source,
      delayMs: Math.max(0, Math.round((startAt - this.audioCtx.currentTime) * 1000)),
      durationMs: Math.round(audioBuffer.duration * 1000),
      // Đoạn tới muộn hơn lúc đoạn trước phát xong: khoảng trống nghe được giữa hai đoạn của cùng một câu.
      lateByMs: Math.max(0, Math.round((this.audioCtx.currentTime - expectedStart) * 1000))
    };
  }

  stopTTS(): void {
    for (const listener of this.ttsStopListeners) {
      try {
        listener();
      } catch {}
    }
    for (const source of this.ttsSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
    this.ttsSources.clear();
    this.nextTTSStartTime = this.audioCtx.currentTime;
  }

  getTTSBacklogMs(): number {
    return Math.max(0, Math.round((this.nextTTSStartTime - this.audioCtx.currentTime) * 1000));
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;

    for (const source of this.ttsSources) {
      try {
        source.stop();
      } catch (error) {
        console.warn('[AudioMixer] TTS stop failed', JSON.stringify({ code: 'TTS_STOP_FAILED', message: String(error) }));
      }
      try {
        source.disconnect();
      } catch (error) {
        console.warn('[AudioMixer] TTS disconnect failed', JSON.stringify({ code: 'TTS_DISCONNECT_FAILED', message: String(error) }));
      }
    }
    this.ttsSources.clear();

    const nodes: AudioNode[] = [this.sourceNode, this.originalGainNode, this.ttsGainNode, this.sttTapNode];
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch (error) {
        console.warn('[AudioMixer] node disconnect failed', JSON.stringify({ code: 'AUDIO_NODE_DISCONNECT_FAILED', message: String(error) }));
      }
    }

    if (this.videoElement && this.savedVideoAudioState) {
      try {
        // Khôi phục đúng volume/mute trước khi extension chiếm đường âm thanh.
        this.videoElement.volume = this.savedVideoAudioState.volume;
        this.videoElement.muted = this.savedVideoAudioState.muted;
      } catch (error) {
        console.error('[AudioMixer] video audio restore failed', JSON.stringify({ code: 'VIDEO_AUDIO_RESTORE_FAILED', message: String(error) }));
      }
    }
  }
}
