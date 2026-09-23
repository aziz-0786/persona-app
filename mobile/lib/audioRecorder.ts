import { requestRecordingPermissionsAsync, setAudioModeAsync, type AudioStream } from "expo-audio";

// Sprint 4C — replaces the chunked expo-av MediaRecorder-rotation approach
// (Sprint 4B) with expo-audio's AudioStream: a genuine native PCM tap
// (its onBuffer callback fires with raw int16 ArrayBuffers in real time),
// not a file-based recorder. This works correctly on BOTH iOS and Android —
// Sprint 4B's Android limitation (expo-av's MediaRecorder backend has no PCM
// output format at all) no longer applies, since AudioStream captures raw
// PCM natively on both platforms. No WAV header to strip, no gap between
// chunks, no per-chunk file I/O.
//
// The actual AudioStream instance must be created via the useAudioStream()
// hook (React hooks can only run at component render time, not imperatively
// inside a plain class) — see mobile/app/call.tsx, which also wires the
// hook's onBuffer callback straight to the Deepgram WebSocket. This class is
// just a thin start/stop wrapper around that hook-provided instance, kept so
// call.tsx's structure (a recorderRef with start()/stop()) stays close to
// the original design.
export class AudioRecorder {
  constructor(private stream: AudioStream) {}

  async start(): Promise<void> {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) throw new Error("Microphone permission denied");

    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await this.stream.start();
  }

  async stop(): Promise<void> {
    this.stream.stop();
  }
}
