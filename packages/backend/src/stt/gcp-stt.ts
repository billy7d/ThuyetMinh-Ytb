import { STTProvider, STTStreamCallbacks, STTStreamSession } from './types.js';

export class GoogleCloudSTTProvider implements STTProvider {
  name = 'GoogleCloudSTT';
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.GCP_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  createStream(sessionId: string, callbacks: STTStreamCallbacks): STTStreamSession {
    if (!this.apiKey) {
      console.warn('[GoogleCloudSTT] No API key configured. Please set GCP_API_KEY in .env');
    }

    // Streaming implementation stub ready for Google Cloud Speech Client
    return {
      sendAudioChunk: (pcmData: Buffer, timestampMs: number) => {
        // When GCP Speech client is initialized, pipe chunk to recognizer stream
      },
      endStream: () => {
        // Close stream
      }
    };
  }
}
