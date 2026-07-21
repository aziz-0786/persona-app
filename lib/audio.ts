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

// ─── Chat playback helpers ──────────────────────────────────────────────────
// Used by /chat/[id] (and, later, the live call page) to play TTS responses:
// decode a base64 WAV from /api/tts and queue it for gapless playback.

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function decodeB64ToAudioBuffer(
  b64: string,
  ctx: AudioContext
): Promise<AudioBuffer> {
  return ctx.decodeAudioData(base64ToArrayBuffer(b64));
}

export interface AudioQueue {
  add: (buffer: AudioBuffer) => void;
  onended: (cb: (() => void) | null) => void;
  // Phase 6: fires once per buffer, right as it's queued — lets the 3D
  // avatar drive lip-sync from the same audio the queue is about to play.
  onBuffer: (cb: ((buffer: AudioBuffer) => void) | null) => void;
  stop: () => void;
  clear: () => void;
}

// Gapless sequential playback: each queued buffer starts the instant the
// previous one finishes. `add()` while idle starts playback immediately;
// `add()` while something is already playing just enqueues it.
export function createAudioQueue(ctx: AudioContext): AudioQueue {
  const queue: AudioBuffer[] = [];
  let currentSource: AudioBufferSourceNode | null = null;
  let endedCb: (() => void) | null = null;
  let bufferCb: ((buffer: AudioBuffer) => void) | null = null;

  function playNext() {
    const buffer = queue.shift();
    if (!buffer) {
      currentSource = null;
      endedCb?.();
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = playNext;
    currentSource = source;
    source.start();
  }

  return {
    add(buffer) {
      bufferCb?.(buffer);
      queue.push(buffer);
      if (!currentSource) playNext();
    },
    onended(cb) {
      endedCb = cb;
    },
    onBuffer(cb) {
      bufferCb = cb;
    },
    // Hard stop: kill whatever's currently audible and drop anything queued.
    stop() {
      queue.length = 0;
      if (currentSource) {
        currentSource.onended = null;
        try {
          currentSource.stop();
        } catch {}
        currentSource = null;
      }
    },
    // Soft stop: let the current clause finish, but don't start any more.
    clear() {
      queue.length = 0;
    },
  };
}

// Splits text into speakable clauses on [,.!?;:—], each with at least 4
// words since the last split — used to feed TTS clause-by-clause as an LLM
// response streams in, rather than waiting for the whole message. Clause
// strings retain their original (untrimmed) substring so
// `clauses.join("").length` always equals how many characters of the input
// were consumed — callers streaming into this can safely compute the
// unconsumed remainder as `text.slice(clauses.join("").length)`.
const CLAUSE_BOUNDARY_CHARS = new Set([",", ".", "!", "?", ";", ":", "—"]);
const MIN_CLAUSE_WORDS = 4;

export function extractClauses(text: string): string[] {
  const clauses: string[] = [];
  let current = "";

  for (const char of text) {
    current += char;
    if (CLAUSE_BOUNDARY_CHARS.has(char)) {
      const wordCount = current.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount >= MIN_CLAUSE_WORDS) {
        clauses.push(current);
        current = "";
      }
    }
  }

  return clauses;
}
