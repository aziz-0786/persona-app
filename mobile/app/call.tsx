import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Animated } from "react-native";
import { useRouter } from "expo-router";
import { useGoogleAuth } from "@/lib/auth";
import { apiFetch, ApiError, API_URL } from "@/lib/api";
import { createDeepgramConnection } from "@/lib/deepgram";
import { AudioRecorder } from "@/lib/audioRecorder";
import { TTSPlayer } from "@/lib/ttsPlayer";

type CallStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended";
type PersonaSummary = { id: string; name: string };
type HistoryTurn = { role: "user" | "assistant"; content: string };

const STATUS_LABELS: Record<CallStatus, string> = {
  idle: "",
  connecting: "Connecting...",
  listening: "Listening...",
  thinking: "Thinking...",
  speaking: "Speaking...",
  ended: "Call ended",
};

// /api/chat streams Server-Sent Events. React Native's fetch streaming
// support is inconsistent across engines/versions, so rather than depend on
// reading the response body chunk-by-chunk (uncertain here), the full SSE
// payload is awaited as one string and parsed in a single pass — this only
// sacrifices incremental "thinking" UI, not correctness, since this screen
// only needs the final assembled response text.
async function fetchChatResponse(params: {
  personaId: string;
  message: string;
  history: HistoryTurn[];
  emotionHistory: string[];
  token: string;
}): Promise<{ text: string; emotion: string }> {
  const res = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personaId: params.personaId,
      message: params.message,
      history: params.history,
      emotionHistory: params.emotionHistory,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `Chat request failed (${res.status})`);
  }

  const raw = await res.text();
  let text = "";
  let emotion = "calm";

  for (const event of raw.split("\n\n")) {
    const line = event.replace(/^data: /, "").trim();
    if (!line || line === "[DONE]") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "emotion") emotion = parsed.emotion;
      else if (parsed.content) text += parsed.content;
    } catch {
      // Malformed/partial SSE line — ignore.
    }
  }

  return { text, emotion };
}

export default function CallScreen() {
  const router = useRouter();
  const { session, isLoading } = useGoogleAuth();

  const [status, setStatus] = useState<CallStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [credits, setCredits] = useState<number | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<TTSPlayer | null>(null);
  const callIdRef = useRef<string | null>(null);
  const startTimeRef = useRef(0);

  const personaIdRef = useRef<string | null>(null);
  const historyRef = useRef<HistoryTurn[]>([]);
  const emotionHistoryRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const endingRef = useRef(false);
  const didStartRef = useRef(false);

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    scaleAnim.stopAnimation();
    opacityAnim.stopAnimation();
    scaleAnim.setValue(1);
    opacityAnim.setValue(0.6);

    let loop: Animated.CompositeAnimation | null = null;
    if (status === "speaking") {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, { toValue: 1.15, duration: 500, useNativeDriver: true }),
          Animated.timing(scaleAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      );
    } else if (status === "listening") {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacityAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(opacityAnim, { toValue: 0.5, duration: 700, useNativeDriver: true }),
        ])
      );
    }
    loop?.start();
    return () => loop?.stop();
  }, [status, scaleAnim, opacityAnim]);

  function handleDeepgramError(err: Error) {
    console.error("[CALL] Deepgram error:", err.message);
    setError(err.message);
  }

  async function handleFinalTranscript(text: string) {
    try {
      await recorderRef.current?.stop();
      setStatus("thinking");

      const token = session!.token;
      const { text: responseText, emotion } = await fetchChatResponse({
        personaId: personaIdRef.current!,
        message: text,
        history: historyRef.current,
        emotionHistory: emotionHistoryRef.current,
        token,
      });

      const newTurns: HistoryTurn[] = [
        { role: "user", content: text },
        { role: "assistant", content: responseText },
      ];
      historyRef.current = [...historyRef.current, ...newTurns].slice(-6);
      emotionHistoryRef.current = [...emotionHistoryRef.current, emotion].slice(-5);

      setAiResponse(responseText);
      setTranscript("");

      if (responseText.trim()) {
        setStatus("speaking");
        await playerRef.current?.play(responseText, personaIdRef.current!, API_URL!, token);
      }

      setStatus("listening");
      if (wsRef.current && recorderRef.current) {
        await recorderRef.current.start(wsRef.current);
      }
    } catch (err) {
      // TODO: remove before prod — debug only, doesn't log transcript/audio content.
      console.error("[CALL] turn failed:", err);
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus("listening");
      if (wsRef.current && recorderRef.current) {
        await recorderRef.current.start(wsRef.current).catch(() => {});
      }
    }
  }

  function handleTranscript(text: string, isFinal: boolean) {
    setTranscript(text);
    if (!isFinal || !text.trim() || processingRef.current) return;
    processingRef.current = true;
    handleFinalTranscript(text.trim()).finally(() => {
      processingRef.current = false;
    });
  }

  async function startCall() {
    try {
      setStatus("connecting");
      setError(null);

      const token = session!.token;

      const personasList = await apiFetch<PersonaSummary[]>("/api/personas");
      const persona = personasList[0];
      if (!persona) {
        setError("No persona found — create one on lyra.app first.");
        return;
      }
      personaIdRef.current = persona.id;

      const { token: deepgramToken } = await apiFetch<{ token: string }>(
        "/api/deepgram-token-mobile"
      );

      const startData = await apiFetch<{ callId: string; balance: number }>("/api/calls/start", {
        method: "POST",
        body: JSON.stringify({ platform: "mobile" }),
      });
      callIdRef.current = startData.callId;
      setCallId(startData.callId);
      setCredits(startData.balance);
      startTimeRef.current = Date.now();

      const ws = await createDeepgramConnection(deepgramToken, handleTranscript, handleDeepgramError);
      wsRef.current = ws;

      const recorder = new AudioRecorder();
      await recorder.start(ws);
      recorderRef.current = recorder;

      playerRef.current = new TTSPlayer();

      setStatus("listening");
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError("No credits — redirecting...");
        setTimeout(() => router.back(), 1000);
        return;
      }
      console.error("[CALL] startCall failed:", err);
      setError(err instanceof Error ? err.message : "Failed to start call");
    }
  }

  async function endCall() {
    if (endingRef.current) return;
    endingRef.current = true;

    await recorderRef.current?.stop();
    wsRef.current?.close(1000, "call ended");
    await playerRef.current?.stop();

    if (callIdRef.current) {
      try {
        const durationSeconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const data = await apiFetch<{ remainingBalance: number }>("/api/calls/end", {
          method: "POST",
          body: JSON.stringify({ callId: callIdRef.current, durationSeconds }),
        });
        setCredits(data.remainingBalance);
      } catch (err) {
        console.error("[CALL] failed to end billed call:", err);
      }
    }

    setStatus("ended");
    setTimeout(() => router.back(), 1000);
  }

  useEffect(() => {
    if (isLoading) return;
    if (!session) {
      setError("Not signed in");
      return;
    }
    if (didStartRef.current) return;
    didStartRef.current = true;
    startCall();

    return () => {
      endCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, session]);

  return (
    <View style={styles.container}>
      {credits !== null && <Text style={styles.creditsBadge}>{credits} credits</Text>}

      <View style={styles.center}>
        <Animated.View
          style={[
            styles.circle,
            {
              transform: [{ scale: scaleAnim }],
              opacity: status === "listening" ? opacityAnim : 1,
            },
          ]}
        />
        <Text style={styles.statusLabel}>{STATUS_LABELS[status]}</Text>
      </View>

      <View style={styles.bottom}>
        {transcript ? <Text style={styles.transcript}>{transcript}</Text> : null}
        {aiResponse ? <Text style={styles.aiResponse}>{aiResponse}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable style={styles.endButton} onPress={endCall}>
          <Text style={styles.endButtonText}>End Call</Text>
        </Pressable>
      </View>
    </View>
  );
}

const ACCENT = "#6C5FF6";

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a", padding: 24, justifyContent: "space-between" },
  creditsBadge: {
    position: "absolute",
    top: 56,
    right: 20,
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  circle: { width: 160, height: 160, borderRadius: 80, backgroundColor: ACCENT },
  statusLabel: { color: "#8080A0", fontSize: 14 },
  bottom: { gap: 12, paddingBottom: 24 },
  transcript: { color: "#F0F0F8", fontSize: 15, textAlign: "center" },
  aiResponse: { color: "#8080A0", fontSize: 14, textAlign: "center" },
  error: { color: "#F04438", fontSize: 13, textAlign: "center" },
  endButton: {
    backgroundColor: "#F04438",
    borderRadius: 20,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  endButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
