import { OperationMode, SessionMetrics, VideoPlaybackState } from './types.js';

export type ClientMessageType =
  | 'SESSION_START'
  | 'AUDIO_CHUNK'
  | 'VIDEO_STATE_UPDATE'
  | 'SEEK_EVENT'
  | 'MODE_CHANGE'
  | 'SESSION_STOP';

export type ServerMessageType =
  | 'SESSION_READY'
  | 'TRANSCRIPT_INTERIM'
  | 'TRANSCRIPT_FINAL'
  | 'TRANSLATION_READY'
  | 'TTS_CHUNK'
  | 'SUBTITLE_EVENT'
  | 'LATENCY_METRIC'
  | 'SESSION_METRICS'
  | 'ERROR';

export interface BaseMessage {
  type: ClientMessageType | ServerMessageType;
  sessionId: string;
  timestamp: number;
}

// Client Messages
export interface SessionStartMessage extends BaseMessage {
  type: 'SESSION_START';
  mode: OperationMode;
  audioSampleRate: number;
  videoUrl?: string;
  videoTitle?: string;
}

export interface AudioChunkMessage extends BaseMessage {
  type: 'AUDIO_CHUNK';
  sequence: number;
  pcmBase64: string; // 16kHz 16-bit mono PCM base64 encoded
  timestampMs: number;
}

export interface VideoStateUpdateMessage extends BaseMessage {
  type: 'VIDEO_STATE_UPDATE';
  state: VideoPlaybackState;
}

export interface SeekEventMessage extends BaseMessage {
  type: 'SEEK_EVENT';
  fromMs: number;
  toMs: number;
  generation: number;
}

export interface ModeChangeMessage extends BaseMessage {
  type: 'MODE_CHANGE';
  mode: OperationMode;
}

export interface SessionStopMessage extends BaseMessage {
  type: 'SESSION_STOP';
  reason?: string;
}

export type ClientMessage =
  | SessionStartMessage
  | AudioChunkMessage
  | VideoStateUpdateMessage
  | SeekEventMessage
  | ModeChangeMessage
  | SessionStopMessage;

// Server Messages
export interface SessionReadyMessage extends BaseMessage {
  type: 'SESSION_READY';
  sessionConfig: {
    audioSampleRate: number;
    chunkDurationMs: number;
  };
}

export interface TranscriptInterimMessage extends BaseMessage {
  type: 'TRANSCRIPT_INTERIM';
  segmentId: string;
  sourceText: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptFinalMessage extends BaseMessage {
  type: 'TRANSCRIPT_FINAL';
  segmentId: string;
  sourceText: string;
  startMs: number;
  endMs: number;
}

export interface TranslationReadyMessage extends BaseMessage {
  type: 'TRANSLATION_READY';
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  generation: number;
}

export interface TTSChunkMessage extends BaseMessage {
  type: 'TTS_CHUNK';
  segmentId: string;
  audioBase64: string; // Audio buffer (WAV / MP3 / PCM)
  durationMs: number;
  generation: number;
  translatedText: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleEventMessage extends BaseMessage {
  type: 'SUBTITLE_EVENT';
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  action: 'show' | 'hide';
}

export interface LatencyMetricMessage extends BaseMessage {
  type: 'LATENCY_METRIC';
  segmentId: string;
  sttMs: number;
  translationMs: number;
  ttsMs: number;
  totalPipelineMs: number;
}

export interface SessionMetricsMessage extends BaseMessage {
  type: 'SESSION_METRICS';
  metrics: SessionMetrics;
}

export interface ErrorMessage extends BaseMessage {
  type: 'ERROR';
  code: string;
  message: string;
  fatal: boolean;
}

export type ServerMessage =
  | SessionReadyMessage
  | TranscriptInterimMessage
  | TranscriptFinalMessage
  | TranslationReadyMessage
  | TTSChunkMessage
  | SubtitleEventMessage
  | LatencyMetricMessage
  | SessionMetricsMessage
  | ErrorMessage;
