/**
 * Helper to generate a valid RIFF WAV audio buffer with realistic acoustic harmonics.
 * Test-only helper for reliable audio fixtures. Production TTS uses a local
 * worker and never falls back to synthetic audio.
 */
export function generateSyntheticWavBuffer(
  durationSeconds: number,
  sampleRate = 16000,
  baseFreq = 220
): Buffer {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2; // 16-bit mono
  const fileSize = 44 + dataSize;
  const buffer = Buffer.alloc(fileSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write('WAVE', 8);

  // "fmt " chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Chunk size
  buffer.writeUInt16LE(1, 20); // Audio format: 1 (PCM)
  buffer.writeUInt16LE(1, 22); // Num channels: 1 (Mono)
  buffer.writeUInt32LE(sampleRate, 24); // Sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32); // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample

  // "data" chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Generate pleasant harmonic speech-like formant tone (vocal tract simulation)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Fundamental + formants at ~220Hz, ~700Hz, ~1200Hz
    const sampleVal =
      0.5 * Math.sin(2 * Math.PI * baseFreq * t) +
      0.3 * Math.sin(2 * Math.PI * (baseFreq * 3.2) * t) +
      0.15 * Math.sin(2 * Math.PI * (baseFreq * 5.4) * t);

    // Apply attack-decay envelope to avoid clicking
    const envelope = Math.min(1, Math.min(t * 20, (durationSeconds - t) * 20));
    const int16Val = Math.max(-32768, Math.min(32767, Math.floor(sampleVal * envelope * 24000)));

    buffer.writeInt16LE(int16Val, 44 + i * 2);
  }

  return buffer;
}
