export interface STTResult {
  /** Provider-stable key for a finalized audio range when available. */
  segmentId?: string;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  confidence: number;
  /** Wall-clock time at which the backend received this provider result. */
  receivedAtMs?: number;
}

export interface STTStreamCallbacks {
  onInterim: (result: STTResult) => void;
  onFinal: (result: STTResult) => void;
  onError: (error: Error) => void;
}

export interface STTStreamSession {
  sendAudioChunk: (pcmData: Buffer, timestampMs: number) => void;
  /** Kết thúc có chốt câu cuối. */
  endStream: () => void;
  /** Hủy ngay (tua/dừng phiên): bỏ audio đang chờ và không nhận dạng phần còn lại. */
  abort?: () => void;
}

/** Lỗi STT kèm mã để pipeline báo đúng loại cho extension. */
export class STTStreamError extends Error {
  constructor(readonly code: string, message: string, readonly fatal = false) {
    super(message);
    this.name = 'STTStreamError';
  }
}

export interface STTProvider {
  name: string;
  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession;
}
