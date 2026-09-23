import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";

// Read directly from app/api/tts/route.ts before writing this: it always
// returns JSON — either { audio_base64, sample_rate } (a full WAV file,
// base64-encoded — both the Cartesia and RunPod/Chatterbox paths produce a
// WAV container) or { error }. It also requires `personaId` in the request
// body (400s without it), which the original spec for this class omitted —
// `play()` below takes it as a required param.
export class TTSPlayer {
  private sound: Audio.Sound | null = null;

  async play(text: string, personaId: string, apiUrl: string, token: string): Promise<void> {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: false,
    });

    const res = await fetch(`${apiUrl}/api/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ personaId, text }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.audio_base64) {
      throw new Error(data.error ?? `TTS request failed (${res.status})`);
    }

    const tempUri = `${FileSystem.cacheDirectory}tts-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(tempUri, data.audio_base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const { sound } = await Audio.Sound.createAsync({ uri: tempUri });
    this.sound = sound;

    await sound.playAsync();

    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) resolve();
      });
    });

    await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
  }

  async stop(): Promise<void> {
    if (!this.sound) return;
    try {
      await this.sound.stopAsync();
      await this.sound.unloadAsync();
    } catch {
      // Already stopped/unloaded — fine.
    }
    this.sound = null;
  }
}
