export type OperationMode = 'dubbing_only' | 'subtitle_only' | 'dubbing_and_subtitle';

export interface AudioMixerConfig {
  originalVolume: number; // 0 to 100
  originalMuted: boolean;
  ttsVolume: number; // 0 to 100
}

export interface VideoPlaybackState {
  currentTime: number; // in seconds
  duration: number;
  paused: boolean;
  playbackRate: number;
  seeking: boolean;
  videoTitle?: string;
  videoUrl?: string;
}

export interface DubbingSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  status: 'interim' | 'final';
  generation: number;
  audioBase64?: string; // PCM/WAV/MP3 audio chunk
  audioDurationMs?: number;
}

export type SessionStatus = 
  | 'idle'
  | 'initializing'
  | 'active'
  | 'paused'
  | 'error'
  | 'stopped';

export type BrowserType = 'chrome' | 'firefox' | 'unknown';

export interface SessionMetrics {
  sessionId: string;
  startTime: number;
  elapsedSeconds: number;
  audioFramesProcessed: number;
  sttSeconds: number;
  translatedCharacters: number;
  ttsCharacters: number;
  estimatedCostUsd: number;
}
