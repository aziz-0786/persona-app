import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

// ── A hard platform limitation, verified against the installed packages ───
//
// expo-av is deprecated (Expo's own current docs: "will be removed in SDK
// 55... not available in SDK 57") but is what this project was explicitly
// told to use instead of expo-audio.
//
// Its Android recording backend goes through MediaRecorder, whose
// AndroidOutputFormat enum has NO raw/PCM output option at all — only
// compressed containers (3GPP, MPEG4, AMR, AAC, WEBM). iOS's
// AVAudioRecorder-backed IOSOutputFormat.LINEARPCM DOES produce real linear
// PCM. That matters here because this class's whole strategy — stop the
// recorder every 250ms, read the file, send its bytes, start a new one —
// only produces a valid continuous stream for raw PCM (a fixed 44-byte WAV
// header can be stripped from each chunk and the remaining bytes concatenate
// cleanly). Every compressed container has internal framing/codec state that
// can't be spliced across independently-rotated files.
//
// Net effect: iOS streams real linear16 PCM to Deepgram correctly. Android,
// via expo-av, cannot — the bytes sent are whatever the OS's DEFAULT encoder
// produces, mislabeled as WAV, and will not transcribe reliably. Closing
// this gap for real needs expo-audio's native PCM tap (or a custom native
// module) — a bigger change than this task's scope.
const WAV_HEADER_BYTES = 44;
const CHUNK_INTERVAL_MS = 250;

function getRecordingOptions(): Audio.RecordingOptions {
  return {
    isMeteringEnabled: false,
    android: {
      extension: ".wav",
      outputFormat: Audio.AndroidOutputFormat.DEFAULT,
      audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 32000,
    },
    ios: {
      extension: ".wav",
      outputFormat: Audio.IOSOutputFormat.LINEARPCM,
      audioQuality: Audio.IOSAudioQuality.HIGH,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 256000,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: {
      mimeType: "audio/webm",
      bitsPerSecond: 128000,
    },
  };
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// React Native/Hermes has no global atob/btoa (verified: not present in the
// installed react-native's polyfill list) — decoding by hand rather than
// depending on a browser global that doesn't exist here.
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((clean.length * 3) / 4) - padding;
  const bytes = new Uint8Array(byteLength);

  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]);
    const c1 = BASE64_CHARS.indexOf(clean[i + 1] ?? "");
    const c2 = BASE64_CHARS.indexOf(clean[i + 2] ?? "");
    const c3 = BASE64_CHARS.indexOf(clean[i + 3] ?? "");

    if (byteIndex < byteLength) bytes[byteIndex++] = (c0 << 2) | (c1 >> 4);
    if (byteIndex < byteLength) bytes[byteIndex++] = ((c1 & 0xf) << 4) | (c2 >> 2);
    if (byteIndex < byteLength) bytes[byteIndex++] = ((c2 & 0x3) << 6) | c3;
  }

  return bytes.buffer;
}

export class AudioRecorder {
  private recording: Audio.Recording | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private rotating = false;

  async start(ws: WebSocket): Promise<void> {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== "granted") throw new Error("Microphone permission denied");

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    this.ws = ws;
    await this._createAndStart();

    this.intervalId = setInterval(() => {
      this._sendChunk().catch((err) => console.error("[AUDIO] chunk rotation failed:", err));
    }, CHUNK_INTERVAL_MS);
  }

  private async _createAndStart(): Promise<void> {
    const { recording } = await Audio.Recording.createAsync(getRecordingOptions());
    this.recording = recording;
  }

  private async _sendChunk(): Promise<void> {
    if (this.rotating || !this.recording || !this.ws) return;
    this.rotating = true;

    try {
      const current = this.recording;
      this.recording = null;

      await current.stopAndUnloadAsync();
      const uri = current.getURI();

      if (uri) {
        // TODO: remove before prod — do not log transcribed audio/content in
        // production paths; this is debug-only and logs neither.
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const buffer = base64ToArrayBuffer(base64);
        // Strip the fixed WAV header so consecutive chunks concatenate into
        // one continuous raw stream (see file header comment re: Android).
        const payload =
          Platform.OS === "ios" && buffer.byteLength > WAV_HEADER_BYTES
            ? buffer.slice(WAV_HEADER_BYTES)
            : buffer;

        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(payload);
        }

        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }

      // expo-av only allows one Recording in the prepared/recording state at
      // a time, so the next chunk can only start once this one is fully
      // stopped — an unavoidable small gap in captured audio on every
      // rotation. Structural limitation of polling-based "streaming" via
      // expo-av, not a bug here.
      if (this.ws) await this._createAndStart();
    } finally {
      this.rotating = false;
    }
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.ws = null;

    const current = this.recording;
    this.recording = null;
    if (current) {
      try {
        await current.stopAndUnloadAsync();
        const uri = current.getURI();
        if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      } catch {
        // Already stopped/unloaded — fine.
      }
    }
  }
}
