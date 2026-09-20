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
  endStream: () => void;
}

export interface STTProvider {
  name: string;
  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession;
}
