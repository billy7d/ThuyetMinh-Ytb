import { calculateFloatPcmStats, diagnosticSessionRef, emitDiagnostic } from '@vietdub/shared';

export interface PCMChunkHandler {
  (pcmBase64: string, timestampMs: number): void;
}

export class PCMProcessor {
  private audioCtx: AudioContext;
  private inputNode: AudioNode;
  private processorNode: ScriptProcessorNode | null = null;
  private silentGainNode: GainNode | null = null;
  private onChunk: PCMChunkHandler;
  private targetSampleRate: number;
  private bufferSize: number;

  private accumulatedSamples: Float32Array[] = [];
  private accumulatedLength: number = 0;
  private targetChunkSamples: number; // 4000 samples = 250ms at 16kHz
  private emittedSamples = 0;
  private sessionId?: string;

  constructor(
    audioCtx: AudioContext,
    inputNode: AudioNode,
    onChunk: PCMChunkHandler,
    targetSampleRate = 16000,
    bufferSize = 4096,
    sessionId?: string
  ) {
    this.audioCtx = audioCtx;
    this.inputNode = inputNode;
    this.onChunk = onChunk;
    this.targetSampleRate = targetSampleRate;
    this.bufferSize = bufferSize;
    this.sessionId = sessionId;
    // 250ms chunk = 0.25 * targetSampleRate (e.g. 4000 samples) -> 4 chunks/sec
    this.targetChunkSamples = Math.round(targetSampleRate * 0.25);

    this.initProcessor();
  }

  private initProcessor(): void {
    // Dùng ScriptProcessorNode để giữ tương thích với cả Chrome và Firefox hiện tại.
    this.processorNode = this.audioCtx.createScriptProcessor(this.bufferSize, 1, 1);

    this.processorNode.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const resampled = this.downsample(inputData, this.audioCtx.sampleRate, this.targetSampleRate);

      this.accumulatedSamples.push(resampled);
      this.accumulatedLength += resampled.length;

      // Khi đủ 250 ms thì ghép mẫu và phát đúng một chunk.
      while (this.accumulatedLength >= this.targetChunkSamples) {
        const chunk = new Float32Array(this.targetChunkSamples);
        let offset = 0;

        while (offset < this.targetChunkSamples && this.accumulatedSamples.length > 0) {
          const first = this.accumulatedSamples[0];
          const needed = this.targetChunkSamples - offset;

          if (first.length <= needed) {
            chunk.set(first, offset);
            offset += first.length;
            this.accumulatedSamples.shift();
          } else {
            chunk.set(first.subarray(0, needed), offset);
            this.accumulatedSamples[0] = first.subarray(needed);
            offset += needed;
          }
        }

        this.accumulatedLength -= this.targetChunkSamples;

        const pcm16 = this.floatTo16BitPCM(chunk);
        const base64 = this.arrayBufferToBase64(pcm16.buffer);
        // Timestamp tính theo số mẫu đã phát ra để nhiều chunk trong một callback vẫn tăng đều.
        const timestampMs = Math.round((this.emittedSamples / this.targetSampleRate) * 1000);
        this.emittedSamples += chunk.length;
        const stats = calculateFloatPcmStats(chunk);
        emitDiagnostic('pcm', 'chunk_emitted', {
          sessionRef: diagnosticSessionRef(this.sessionId),
          sampleCount: stats.sampleCount,
          byteLength: pcm16.byteLength,
          rms: Math.round(stats.rms * 10000) / 10000,
          peak: Math.round(stats.peak * 10000) / 10000,
          nonZeroSamples: stats.nonZeroSamples,
          hasSignal: stats.rms >= 0.015,
          timestampMs
        });
        try {
          this.onChunk(base64, timestampMs);
        } catch (error) {
          console.error('[PCMProcessor] chunk handler failed', JSON.stringify({ code: 'PCM_CHUNK_HANDLER_FAILED', message: String(error) }));
        }
      }
    };

    this.inputNode.connect(this.processorNode);
    // Nối qua gain im lặng để ScriptProcessor tiếp tục chạy mà không phát thêm âm thanh.
    this.silentGainNode = this.audioCtx.createGain();
    this.silentGainNode.gain.value = 0;
    this.processorNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.audioCtx.destination);
  }

  private downsample(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
    if (inputSampleRate === outputSampleRate) return buffer;
    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  private floatTo16BitPCM(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output;
  }

  private arrayBufferToBase64(buffer: ArrayBufferLike): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  stop(): void {
    if (this.processorNode) {
      const processorNode = this.processorNode;
      try {
        // Gỡ cả chiều input để không giữ processor trong đồ thị Web Audio sau khi dừng.
        this.inputNode.disconnect(processorNode);
      } catch (error) {
        console.warn('[PCMProcessor] input disconnect failed', JSON.stringify({ code: 'PCM_INPUT_DISCONNECT_FAILED', message: String(error) }));
      }
      processorNode.disconnect();
      processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    if (this.silentGainNode) {
      this.silentGainNode.disconnect();
      this.silentGainNode = null;
    }
    this.accumulatedSamples = [];
    this.accumulatedLength = 0;
    this.emittedSamples = 0;
  }
}
