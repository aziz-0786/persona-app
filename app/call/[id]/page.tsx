"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Mic, MicOff, PhoneOff, Zap } from "lucide-react";
import { cn, EMOTION_EMOJI, formatDuration } from "@/lib/utils";

type ConvState = "idle" | "listening" | "thinking" | "speaking";
type Emotion = "happy" | "amused" | "calm" | "thinking" | "sad" | "angry" | "surprised";

export default function CallPage() {
  const { id: personaId } = useParams<{ id: string }>();
  const router = useRouter();

  const [state, setState] = useState<ConvState>("idle");
  const [emotion, setEmotion] = useState<Emotion>("calm");
  const [isMuted, setIsMuted] = useState(false);
  const [showLatency, setShowLatency] = useState(false);
  const [personaName, setPersonaName] = useState("...");
  const [lastUserText, setLastUserText] = useState("");
  const [lastAssistantText, setLastAssistantText] = useState("");
  const [elapsed, setElapsed] = useState(0);

  // Latency tracking
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [llmMs, setLlmMs] = useState<number | null>(null);
  const [ttsMs, setTtsMs] = useState<number | null>(null);

  // Refs for cleanup
  const abortRef = useRef<AbortController | null>(null);
  const audioQueueRef = useRef<HTMLAudioElement[]>([]);
  const isPlayingRef = useRef(false);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch persona name on mount
  useEffect(() => {
    fetch(`/api/personas?id=${personaId}`)
      .then((r) => r.json())
      .then((d) => setPersonaName(d.name ?? "Persona"))
      .catch(() => setPersonaName("Persona"));

    // Start elapsed timer
    elapsedIntervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    };
  }, [personaId]);

  function stopAudio() {
    audioQueueRef.current.forEach((a) => {
      a.pause();
      a.currentTime = 0;
    });
    audioQueueRef.current = [];
    isPlayingRef.current = false;
  }

  function interrupt() {
    abortRef.current?.abort();
    stopAudio();
    setState("listening");
  }

  function endCall() {
    abortRef.current?.abort();
    stopAudio();
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    router.push("/");
  }

  // Phase 5 will wire up Deepgram STT, /api/chat, /api/tts, TalkingHead avatar

  return (
    <div className="h-screen w-screen bg-void flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/40">
        <div className="flex items-center gap-3">
          <div
            className={cn("w-2 h-2 rounded-full", {
              "bg-text-muted": state === "idle",
              "bg-accent animate-pulse": state === "listening",
              "bg-warning animate-pulse-slow": state === "thinking",
              "bg-success animate-pulse": state === "speaking",
            })}
          />
          <span className="font-display font-semibold text-text-primary">
            {personaName}
          </span>
          {emotion && (
            <span className="text-xs bg-elevated border border-border rounded-full px-2 py-0.5 text-text-secondary">
              {EMOTION_EMOJI[emotion] ?? "😌"} {emotion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-text-muted">
            {formatDuration(elapsed)}
          </span>
          <button
            onClick={() => setShowLatency(!showLatency)}
            className="p-1.5 rounded-lg hover:bg-elevated text-text-muted hover:text-text-secondary transition-colors"
            title="Toggle latency overlay"
          >
            <Zap size={14} />
          </button>
        </div>
      </div>

      {/* Avatar area */}
      <div className="flex-1 flex flex-col items-center justify-center gap-4 relative">
        {/* Avatar container with state ring */}
        <div className="relative">
          <div
            className={cn(
              "w-52 h-52 lg:w-64 lg:h-64 rounded-full overflow-hidden bg-elevated border-4 border-surface transition-all duration-300",
              {
                "ring-idle":      state === "idle",
                "ring-listening": state === "listening",
                "ring-thinking":  state === "thinking",
                "ring-speaking":  state === "speaking",
              }
            )}
            id="avatar-container"
          >
            {/* Phase 6: TalkingHead.js mounts here */}
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-7xl lg:text-8xl">
                {state === "thinking" ? "🤔" : state === "speaking" ? "💬" : "🧑"}
              </span>
            </div>
          </div>
        </div>

        {/* Transcript area */}
        <div className="text-center px-6 space-y-1 min-h-[3rem]">
          {lastAssistantText && (
            <p className="text-sm text-text-primary max-w-md mx-auto line-clamp-2">
              &ldquo;{lastAssistantText}&rdquo;
            </p>
          )}
          {lastUserText && (
            <p className="text-xs text-text-muted max-w-sm mx-auto truncate">
              You: {lastUserText}
            </p>
          )}
        </div>

        {/* State label */}
        <p className="text-xs font-medium text-text-muted tracking-wide uppercase">
          {state === "idle"      && "Hold to speak"}
          {state === "listening" && "Listening..."}
          {state === "thinking"  && "..."}
          {state === "speaking"  && `${personaName} is speaking`}
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6 pb-10 px-5">
        {/* Mute */}
        <button
          onClick={() => setIsMuted(!isMuted)}
          className={cn(
            "w-12 h-12 rounded-full flex items-center justify-center border transition-colors",
            isMuted
              ? "bg-error/10 border-error/30 text-error"
              : "bg-elevated border-border text-text-secondary hover:text-text-primary"
          )}
        >
          {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        {/* Push-to-talk (main button) */}
        <button
          onPointerDown={() => state === "idle" && setState("listening")}
          onPointerUp={() => state === "listening" && setState("thinking")}
          onPointerLeave={() => state === "listening" && setState("thinking")}
          className={cn(
            "w-20 h-20 rounded-full flex items-center justify-center border-2 transition-all duration-150 select-none touch-none active:scale-95",
            state === "listening"
              ? "bg-accent border-accent shadow-glow scale-105"
              : state !== "idle"
              ? "bg-elevated border-border opacity-50 cursor-not-allowed"
              : "bg-elevated border-border hover:border-accent/50 hover:bg-elevated"
          )}
          disabled={state !== "idle" && state !== "listening"}
        >
          <Mic
            size={28}
            className={state === "listening" ? "text-white" : "text-text-secondary"}
          />
        </button>

        {/* End call */}
        <button
          onClick={endCall}
          className="w-12 h-12 rounded-full flex items-center justify-center bg-error/10 border border-error/30 text-error hover:bg-error/20 transition-colors"
        >
          <PhoneOff size={18} />
        </button>
      </div>

      {/* Latency overlay */}
      {showLatency && (
        <div className="fixed bottom-28 left-4 bg-surface border border-border rounded-xl p-3 space-y-1 font-mono text-xs">
          <div className="text-text-muted text-[10px] uppercase font-medium mb-1">Latency</div>
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">STT</span>
            <span className={sttMs ? "text-success" : "text-text-muted"}>
              {sttMs ? `${sttMs}ms` : "—"}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">LLM</span>
            <span className={llmMs ? "text-success" : "text-text-muted"}>
              {llmMs ? `${llmMs}ms` : "—"}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">TTS</span>
            <span className={ttsMs ? "text-success" : "text-text-muted"}>
              {ttsMs ? `${ttsMs}ms` : "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
