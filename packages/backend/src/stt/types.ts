export interface STTResult {
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  confidence: number;
}

export interface STTStreamCallbacks {
  onInterim: (text: string, startMs: number, endMs: number) => void;
  onFinal: (text: string, startMs: number, endMs: number) => void;
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
