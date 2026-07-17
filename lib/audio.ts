// Browser-only audio helpers for the Voice tab: WAV encoding (Chatterbox's
// worker expects a WAV reference clip), RMS level, and base64 packing.

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function interleave(left: Float32Array, right: Float32Array): Float32Array {
  const length = left.length + right.length;
  const result = new Float32Array(length);
  let index = 0;
  let inputIndex = 0;
  while (index < length) {
    result[index++] = left[inputIndex];
    result[index++] = right[inputIndex];
    inputIndex++;
  }
  return result;
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

export function encodeWavPCM16(audioBuffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;

  const samples =
    numChannels === 2
      ? interleave(audioBuffer.getChannelData(0), audioBuffer.getChannelData(1))
      : audioBuffer.getChannelData(0);

  const dataLength = samples.length * (bitDepth / 8);
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  floatTo16BitPCM(view, 44, samples);

  return buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Index-based loop, not spread — spreading a typed array requires
  // downlevelIteration / an ES2015+ target, which this project's tsconfig doesn't set.
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function computeRms(audioBuffer: AudioBuffer): number {
  const data = audioBuffer.getChannelData(0);
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
  return Math.sqrt(sumSquares / data.length);
}

// Below this level the clip is mostly noise floor / silence rather than
// clear speech — reference audio this quiet degrades voice cloning quality.
export const NOISY_DBFS_THRESHOLD = -40;

export function rmsToDbfs(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export interface ProcessedAudio {
  base64: string;
  durationSec: number;
  rms: number;
  dbfs: number;
  tooNoisy: boolean;
}

// Decodes any browser-supported audio (webm/opus recording, wav/mp3/m4a
// upload) and re-encodes it as PCM16 WAV, which is what the TTS worker
// expects as a reference clip.
export async function processAudioToWav(source: ArrayBuffer): Promise<ProcessedAudio> {
  const AudioContextCtor: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioContextCtor();

  try {
    const audioBuffer = await ctx.decodeAudioData(source.slice(0));
    const wav = encodeWavPCM16(audioBuffer);
    const rms = computeRms(audioBuffer);
    const dbfs = rmsToDbfs(rms);

    return {
      base64: arrayBufferToBase64(wav),
      durationSec: audioBuffer.duration,
      rms,
      dbfs,
      tooNoisy: dbfs < NOISY_DBFS_THRESHOLD,
    };
  } finally {
    ctx.close();
  }
}
