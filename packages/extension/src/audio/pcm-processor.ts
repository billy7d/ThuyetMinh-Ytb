export interface PCMChunkHandler {
  (pcmBase64: string, timestampMs: number): void;
}

export class PCMProcessor {
  private audioCtx: AudioContext;
  private inputNode: AudioNode;
  private processorNode: ScriptProcessorNode | null = null;
  private onChunk: PCMChunkHandler;
  private targetSampleRate: number;
  private bufferSize: number;
  private readonly getTimestampMs: () => number;
  private readonly silentGain: GainNode;
  private sequence = 0;

  constructor(
    audioCtx: AudioContext,
    inputNode: AudioNode,
    onChunk: PCMChunkHandler,
    targetSampleRate = 16000,
    bufferSize = 4096,
    getTimestampMs: () => number = () => Math.round(this.audioCtx.currentTime * 1000)
  ) {
    this.audioCtx = audioCtx;
    this.inputNode = inputNode;
    this.onChunk = onChunk;
    this.targetSampleRate = targetSampleRate;
    this.bufferSize = bufferSize;
    this.getTimestampMs = getTimestampMs;
    this.silentGain = this.audioCtx.createGain();

    this.initProcessor();
  }

  private initProcessor(): void {
    // Standard ScriptProcessorNode for maximum browser compatibility across Chrome/Firefox
    this.processorNode = this.audioCtx.createScriptProcessor(this.bufferSize, 1, 1);

    this.processorNode.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const resampled = this.downsample(inputData, this.audioCtx.sampleRate, this.targetSampleRate);
      const pcm16 = this.floatTo16BitPCM(resampled);
      const base64 = this.arrayBufferToBase64(pcm16.buffer);
      const timestampMs = this.getTimestampMs();

      this.onChunk(base64, timestampMs);
    };

    this.inputNode.connect(this.processorNode);
    // Connect to destination via silent node to keep processor running
    this.silentGain.gain.value = 0;
    this.processorNode.connect(this.silentGain);
    this.silentGain.connect(this.audioCtx.destination);
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
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    this.silentGain.disconnect();
  }
}
