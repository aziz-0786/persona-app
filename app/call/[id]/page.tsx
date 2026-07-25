"use client";
import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { usePersona } from "@/lib/hooks";
import { decodeB64ToAudioBuffer, createAudioQueue, extractClauses, type AudioQueue } from "@/lib/audio";
import WallpaperCall from "@/components/WallpaperCall";

// No TS types ship for the TalkingHead instance — headRef/onBuffer lip-sync
// wiring is now dead now that Avatar3D is gone, but harmless to leave typed
// this way if it's ever reconnected to a future video-avatar element.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TalkingHeadInstance = any;

type ConvState = "idle" | "listening" | "thinking" | "speaking";
type HistoryTurn = { role: "user" | "assistant"; content: string };

// nova-3 + interim results for live captions, smart_format for punctuation,
// endpointing=500 so Deepgram finalizes ~500ms after the speaker stops
// (was 300ms — too eager, cut sentences off mid-thought). utterance_end_ms=1500
// additionally waits for 1.5s of silence before emitting an UtteranceEnd,
// giving a second, more patient signal for natural pauses.
// No `encoding`/`sample_rate` param — MediaRecorder's webm/opus container is
// auto-detected by Deepgram from the stream header, so raw Blob chunks can
// be sent as-is.
const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&interim_results=true&smart_format=true&endpointing=500&utterance_end_ms=1500";

// Deepgram closes a connection after ~10-12s with no data at all. Idle
// (waiting for push-to-talk) and thinking (LLM+TTS running) can both last
// longer than that with no audio being forwarded — KeepAlive is a control
// message (not audio), so it holds the socket open without tripping
// endpointing or contributing to the transcript.
const KEEPALIVE_INTERVAL_MS = 8_000;

export default function CallPage() {
  const { id: personaId } = useParams<{ id: string }>();
  const router = useRouter();
  const { persona } = usePersona(personaId);
  const personaName = persona?.name ?? "...";

  const [state, setState] = useState<ConvState>("idle");
  const [emotion, setEmotion] = useState("calm");
  const [isMuted, setIsMuted] = useState(false);
  const [showLatency, setShowLatency] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [lastUserText, setLastUserText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [lastAssistantText, setLastAssistantText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [warmupDone, setWarmupDone] = useState(false);
  const [warmupFailed, setWarmupFailed] = useState(false);
  const [userTapped, setUserTapped] = useState(false);
  const greetingAudioRef = useRef<string | null>(null);
  const greetingSampleRateRef = useRef<number>(24000);
  const greetingPlayedRef = useRef(false);

  // Latency tracking
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [llmMs, setLlmMs] = useState<number | null>(null);
  const [ttsMs, setTtsMs] = useState<number | null>(null);

  // Mirrors `state` into a ref — WS/MediaRecorder callbacks are registered
  // once and would otherwise close over a stale value.
  const stateRef = useRef<ConvState>("idle");
  function setConvState(next: ConvState) {
    stateRef.current = next;
    setState(next);
  }

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  // Gate on whether MediaRecorder chunks get forwarded to Deepgram. Mic
  // capture itself never stops (needed for barge-in detection while the
  // persona is speaking) — only forwarding is toggled: on while
  // listening/speaking, off while idle/thinking.
  const sendAudioRef = useRef(false);
  const keepAliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const historyRef = useRef<HistoryTurn[]>([]);
  // Incremented on every submitTurn call — lets stale async work (a
  // superseded turn's SSE loop or TTS chain) recognize it's been interrupted
  // and stop touching state.
  const turnIdRef = useRef(0);
  // Separate controllers so aborting one never cancels the other — e.g. a
  // TTS-only failure/retry shouldn't kill an LLM stream still in progress.
  const llmAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioQueue | null>(null);
  const sttStartRef = useRef<number | null>(null);
  // Latest interim transcript while listening — used as a fallback if
  // Deepgram never sends a final after CloseStream (see handleMicClick).
  const accTranscriptRef = useRef("");
  const cleanupRef = useRef<(() => void) | null>(null);
  const didInitRef = useRef(false);
  const deepgramCancelledRef = useRef(false);
  const micInitPromiseRef = useRef<Promise<void> | null>(null);
  const headRef = useRef<TalkingHeadInstance>(null);

  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new AudioCtx();
    }
    return audioCtxRef.current;
  }

  function getAudioQueue(): AudioQueue {
    if (!audioQueueRef.current) {
      const queue = createAudioQueue(getAudioContext());
      // Drives the 3D avatar's lip-sync off the same buffers the queue is
      // about to play — registered once here rather than per-turn, since
      // unlike onended it doesn't need any turn-specific state.
      queue.onBuffer((buffer) => {
        headRef.current?.speakAudio?.({
          audio: buffer,
          words: [],
          wtimes: [],
          wdurations: [],
        });
      });
      audioQueueRef.current = queue;
    }
    return audioQueueRef.current;
  }

  // ── Turn pipeline: /api/chat SSE → clause splitter → /api/tts → audio queue
  async function submitTurn(transcript: string) {
    const trimmed = transcript.trim();
    if (!trimmed) return;
    console.log("[TURN] submitting:", trimmed);

    const myTurnId = ++turnIdRef.current;
    const myLlmController = new AbortController();
    const myTtsController = new AbortController();
    let ctx: AudioContext;

    try {
      // A new turn always supersedes whatever the previous one was doing —
      // both its LLM stream and its TTS fetches are stale now.
      llmAbortRef.current?.abort();
      ttsAbortRef.current?.abort();
      llmAbortRef.current = myLlmController;
      ttsAbortRef.current = myTtsController;

      historyRef.current = [...historyRef.current, { role: "user", content: trimmed }];
      setLastUserText(trimmed);
      setInterimText("");
      setSttMs(sttStartRef.current ? Date.now() - sttStartRef.current : null);
      setLlmMs(null);
      setTtsMs(null);
      setConvState("thinking");
      sendAudioRef.current = false;

      ctx = getAudioContext();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      getAudioQueue().stop();
    } catch (err) {
      console.error("[TURN] submitTurn setup failed:", err);
      if (turnIdRef.current === myTurnId) {
        setConvState("idle");
        sendAudioRef.current = false;
      }
      return;
    }

    const turnStart = Date.now();
    let firstTokenSeen = false;
    let firstAudioSeen = false;
    let fullText = "";
    let clauseBuffer = "";
    let liveEmotion = "calm";
    let voiceMissing = false;
    let anyClauseAttempted = false;
    let ttsChain: Promise<void> = Promise.resolve();

    function flushClause(clauseText: string) {
      const clause = clauseText.trim();
      if (!clause || voiceMissing) return;
      anyClauseAttempted = true;

      const fetchPromise = (async (): Promise<AudioBuffer | null> => {
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personaId, text: clause, emotion: liveEmotion }),
            signal: myTtsController.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (res.status === 422) voiceMissing = true;
          if (!res.ok || data.error || !data.audio_base64) {
            console.error("[TTS] clause failed:", res.status, data.error ?? "no audio_base64", clause);
            return null;
          }
          return await decodeB64ToAudioBuffer(data.audio_base64, ctx);
        } catch (err) {
          console.error("[TTS] clause fetch threw:", err);
          return null;
        }
      })();

      // Fetches run concurrently for latency, but the chain guarantees
      // clauses are queued in generation order, not fetch-resolution order.
      ttsChain = ttsChain.then(async () => {
        const buffer = await fetchPromise;
        if (!buffer || turnIdRef.current !== myTurnId) return;

        const queue = getAudioQueue();
        if (!firstAudioSeen) {
          firstAudioSeen = true;
          setTtsMs(Date.now() - turnStart);
          setConvState("speaking");
          // Barge-in is intentionally not supported (see the state gate in
          // connectDeepgram's ws.onmessage) — mic forwarding stays off
          // through "speaking" too, since nothing would ever act on a
          // transcript arriving during it, and forwarding it anyway is
          // exactly what let TTS echo reach Deepgram in the first place.
          queue.onended(() => {
            if (turnIdRef.current !== myTurnId) return;
            setConvState("idle");
            sendAudioRef.current = false;
          });
        }
        queue.add(buffer);
      });
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: myLlmController.signal,
        body: JSON.stringify({
          personaId,
          message: trimmed,
          history: historyRef.current.slice(-6),
        }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // SSE events are separated by "\n\n" and can arrive split across
      // multiple read() calls — buffer and only parse complete events.
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() ?? "";

        for (const event of events) {
          const line = event.replace(/^data: /, "").trim();
          if (!line || line === "[DONE]") continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "emotion") {
              liveEmotion = parsed.emotion;
              if (turnIdRef.current === myTurnId) setEmotion(parsed.emotion);
            } else if (parsed.type === "error") {
              if (turnIdRef.current === myTurnId) {
                setLastAssistantText(`⚠ ${parsed.message}`);
                setConvState("idle");
                sendAudioRef.current = false;
              }
              return;
            } else if (parsed.content) {
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                setLlmMs(Date.now() - turnStart);
              }
              fullText += parsed.content;
              clauseBuffer += parsed.content;

              const clauses = extractClauses(clauseBuffer);
              if (clauses.length > 0) {
                clauseBuffer = clauseBuffer.slice(clauses.join("").length);
                clauses.forEach(flushClause);
              }
              if (turnIdRef.current === myTurnId) setLastAssistantText(fullText);
            }
          } catch {}
        }
      }

      if (clauseBuffer.trim()) flushClause(clauseBuffer);
      if (turnIdRef.current === myTurnId && fullText.trim()) {
        historyRef.current = [...historyRef.current, { role: "assistant", content: fullText }];
      }

      // Not awaited — if TTS is still mid cold-start, the turn shouldn't
      // block. Once every clause fetch has settled, fall back to idle only
      // if audio never actually started (e.g. TTS failed, or no voice ref).
      ttsChain.then(() => {
        if (turnIdRef.current === myTurnId && !firstAudioSeen) {
          setConvState("idle");
          sendAudioRef.current = false;
          if (anyClauseAttempted) {
            console.error("[TTS] all clauses failed for turn, no audio queued");
            setMicError("Voice failed — tap to try again");
          }
        }
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // interrupted or superseded
      console.error("[TURN] submitTurn failed:", err);
      if (turnIdRef.current === myTurnId) {
        setLastAssistantText("Something went wrong. Try again.");
        setConvState("idle");
        sendAudioRef.current = false;
      }
    }
  }

  async function connectDeepgram() {
    try {
      const tokenRes = await fetch("/api/deepgram-token");
      const tokenData = await tokenRes.json();
      // Guards against a race where the component unmounts (or this effect's
      // cleanup ran) while the token fetch was in flight — without this, a
      // late-resolving fetch would still open a second WebSocket and mint a
      // second rate-limited (250/day) Deepgram key nobody's listening to.
      if (deepgramCancelledRef.current) return;
      if (!tokenRes.ok || !tokenData.token) {
        setMicError(tokenData.error ?? "Failed to get transcription token");
        return;
      }

      // Browsers can't set a custom Authorization header on a WebSocket
      // handshake — the Sec-WebSocket-Protocol subprotocol array is the way
      // around that. This only works because /api/deepgram-token now mints a
      // short (~40 char) project API key rather than a JWT — JWTs from
      // /v1/auth/grant are too long to fit in this header and get rejected.
      const ws = new WebSocket(DEEPGRAM_WS_URL, ["token", tokenData.token]);

      ws.onmessage = (event) => {
        let msg: {
          type?: string;
          is_final?: boolean;
          channel?: { alternatives?: { transcript?: string }[] };
        };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        // Only Results messages carry a transcript — Metadata, UtteranceEnd,
        // etc. are logged (for visibility) but never reach submitTurn.
        if (msg.type !== "Results") {
          console.log("[DG] non-Results message:", msg.type);
          return;
        }

        const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";
        const isFinal = msg.is_final;

        if (!isFinal) {
          if (transcript) {
            accTranscriptRef.current = transcript;
            if (stateRef.current === "listening") setInterimText(transcript);
          }
          return;
        }

        console.log("[DG] FINAL transcript:", transcript, "state:", stateRef.current);

        // *** THE CRITICAL GATE ***
        // The persona's own TTS audio can leak back into the mic (no
        // headphones, speaker bleed) while sendAudioRef is on. It used to be
        // on during "speaking" specifically to support barge-in — but that
        // meant an echo Deepgram finalized as speech re-triggered submitTurn
        // while still "thinking"/"speaking", aborting the in-flight TTS,
        // producing no audio, tripping the stuck-in-thinking timeout, and
        // getting resubmitted again on the next echo — a self-sustaining
        // loop. Only a final that arrives while genuinely "listening" (the
        // user explicitly clicked to talk) is trusted now; barge-in is
        // removed as the trade-off for not looping on echo.
        if (stateRef.current !== "listening") {
          console.log("[DG] ignoring final — state is", stateRef.current, "not listening");
          return;
        }

        if (!transcript.trim()) return;
        accTranscriptRef.current = "";
        submitTurn(transcript.trim());
      };
      // Without this, a transient WS error (e.g. a brief handshake hiccup)
      // leaves micError stuck true forever — there was no path back to null,
      // permanently disabling the mic button for the rest of the session.
      ws.onopen = () => setMicError(null);
      ws.onerror = () => setMicError("Speech recognition connection error");
      wsRef.current = ws;

      keepAliveIntervalRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    } catch {
      setMicError("Failed to connect to speech recognition");
    }
  }

  async function initMic() {
    try {
      // echoCancellation specifically targets device-speaker audio bleeding
      // back into the mic (the persona's own TTS playback) — the browser-
      // level counterpart to the state-gate fix in connectDeepgram's
      // ws.onmessage, which stops a leaked echo from being acted on at all.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      micStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && sendAudioRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };
      recorder.start(250);
      mediaRecorderRef.current = recorder;
    } catch {
      setMicError("Microphone access denied. Allow mic access and reload.");
    }
  }

  // Mic capture (getUserMedia + MediaRecorder) is deferred to the first
  // button press, not started on mount — the permission prompt and the
  // browser's recording indicator shouldn't appear before the user actually
  // tries to talk. De-duped via a shared promise since a fast press/release/
  // press could otherwise call initMic() twice concurrently.
  async function ensureMicReady(): Promise<void> {
    if (micStreamRef.current) return;
    if (!micInitPromiseRef.current) {
      micInitPromiseRef.current = initMic();
    }
    await micInitPromiseRef.current;
  }

  // Plays the pre-fetched greeting. Only ever called from the "Tap to
  // connect" button's onClick — that's the user gesture that unlocks
  // AudioContext.resume()/playback on Chrome/Safari. Calling this
  // automatically from ws.onopen or the TTS fetch's .then() (no user
  // gesture yet) would have the browser silently block it.
  async function tryPlayGreeting() {
    if (greetingPlayedRef.current) return;
    if (!greetingAudioRef.current) return;
    greetingPlayedRef.current = true;
    try {
      const ctx = getAudioContext();
      await ctx.resume(); // safe to call again, idempotent
      const buf = await decodeB64ToAudioBuffer(greetingAudioRef.current, ctx);
      setConvState("speaking");
      sendAudioRef.current = false;
      const queue = getAudioQueue();
      queue.onended(() => setConvState("idle"));
      queue.add(buf);
    } catch (e) {
      console.warn("[WARMUP] greeting play failed:", e);
      // Silent failure — user is already in the call UI, just no greeting.
    }
  }

  // Fires a short TTS ping the instant the persona loads, while the user is
  // still looking at the "Connecting..." screen — this is what actually
  // eliminates cold-start silence: by the time the user taps the mic, the
  // RunPod worker (5-8 min cold start otherwise) is already warm.
  useEffect(() => {
    if (!persona) return;

    const greetingText = "Hey, good to hear from you.";

    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personaId: persona.id,
        text: greetingText,
        emotion: "happy",
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.audio_base64) {
          greetingAudioRef.current = data.audio_base64;
          greetingSampleRateRef.current = data.sample_rate ?? 24000;
        } else {
          setWarmupFailed(true);
        }
        setWarmupDone(true);
      })
      .catch(() => {
        // Even on failure, let the user in — just no greeting.
        setWarmupFailed(true);
        setWarmupDone(true);
      });
    // Runs once when persona first loads — refetching on every persona
    // object identity change (e.g. an unrelated PATCH elsewhere) would
    // re-fire the greeting TTS call, which isn't the intent here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona]);

  useEffect(() => {
    // Guards against React Strict Mode's dev-only double-invoke (mount →
    // cleanup → mount) — without it, this ran connectDeepgram() (and its
    // /api/deepgram-token call, which is rate-limited to 250/day) twice on
    // every load. Strict Mode is also disabled in next.config.mjs, since a
    // guard alone would still leave the WS/mic torn down and never
    // reconnected if Strict Mode's synthetic cleanup ran in between.
    if (didInitRef.current) return;
    didInitRef.current = true;

    let disposed = false;
    connectDeepgram();
    elapsedIntervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      deepgramCancelledRef.current = true;
      llmAbortRef.current?.abort();
      ttsAbortRef.current?.abort();
      audioQueueRef.current?.stop();
      audioCtxRef.current?.close().catch(() => {});
      try {
        wsRef.current?.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      try {
        wsRef.current?.close();
      } catch {}
      mediaRecorderRef.current?.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (keepAliveIntervalRef.current) clearInterval(keepAliveIntervalRef.current);
      if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    };
    cleanupRef.current = cleanup;

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId]);

  function toggleMute() {
    setIsMuted((prev) => {
      const next = !prev;
      micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }

  // Click-to-toggle: first click starts listening, second click stops
  // sending audio and lets Deepgram's endpointing (500ms) finalize the
  // utterance. Ignored while a response is in flight ("thinking"/"speaking")
  // — not while "idle", since that's the state the first click must act on.
  async function handleMicClick() {
    const currentState = stateRef.current as ConvState;
    if (isMuted || currentState === "thinking" || currentState === "speaking") return;

    if (currentState === "listening") {
      sendAudioRef.current = false;
      setConvState("thinking");

      // Prompt Deepgram to flush/finalize now rather than waiting purely on
      // the passive absence-of-audio endpointing heuristic.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }

      // Safety net: if no final arrives within 800ms of CloseStream (e.g.
      // Deepgram closes out without ever emitting one), fall back to
      // whatever the last interim transcript was instead of hanging in
      // "thinking" forever.
      setTimeout(() => {
        if (stateRef.current === "thinking" && accTranscriptRef.current.trim()) {
          console.log("[TURN] submitting from accumulator:", accTranscriptRef.current);
          const fallbackTranscript = accTranscriptRef.current;
          accTranscriptRef.current = "";
          submitTurn(fallbackTranscript);
        }
      }, 800);
      return;
    }

    // currentState === "idle" — first click, start listening. Clears any
    // prior error banner (mic permission, Deepgram connect, TTS failure)
    // since this click is the user's retry action.
    sttStartRef.current = Date.now();
    setInterimText("");
    accTranscriptRef.current = "";
    setMicError(null);
    setConvState("listening");

    await ensureMicReady();

    // The user may have already clicked again (or a mic error surfaced)
    // while getUserMedia was pending — don't start forwarding audio if so.
    const stateAfterMic = stateRef.current as ConvState;
    if (stateAfterMic === "listening" && micStreamRef.current) {
      sendAudioRef.current = true;
    }
  }

  async function endCall() {
    cleanupRef.current?.();

    if (historyRef.current.length > 0) {
      try {
        await fetch("/api/memory/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            personaId,
            transcript: historyRef.current.map((t) => `${t.role}: ${t.content}`).join("\n"),
          }),
        });
      } catch {}
    }

    router.push("/");
  }

  // Warmup pre-screen: fires the greeting TTS ping the instant persona
  // loads (see the useEffect above) and holds here until it settles, so the
  // RunPod worker is already warm by the time the user reaches the mic
  // button — no navigation, no reload, the conditional just disappears once
  // warmupDone flips true and the user taps through. WallpaperCall lives in
  // ONE place below (in the always-mounted main UI) — it never unmounts
  // across the warmup transition. The overlay just sits on top (z-10) and
  // disappears once userTapped; the main UI underneath is toggled
  // invisible/block via CSS only, never removed from the tree.
  //
  // WallpaperCall replaces the old custom top bar/avatar/transcript/controls
  // /latency-overlay markup wholesale — it's a self-contained fixed
  // full-screen call UI with its own equivalents of most of that. Two
  // things it doesn't have a slot for and are therefore no longer shown:
  // the mute button and the micError banner (isMuted/toggleMute/micError
  // state all still exist and work, just aren't surfaced in this UI).
  const combinedLatencyMs = (sttMs ?? 0) + (llmMs ?? 0) + (ttsMs ?? 0);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div className={cn("h-screen w-screen", !warmupDone && "invisible")}>
        <WallpaperCall
          persona={{
            name: personaName,
            photoUrl: persona?.photoUrl,
            relationship: persona?.relationship,
          }}
          state={state}
          emotion={emotion}
          elapsedSeconds={elapsed}
          onMicPress={handleMicClick}
          onMicRelease={() => {}}
          onEndCall={endCall}
          latencyMs={combinedLatencyMs}
        />
      </div>

      {/* Warmup overlay — covers the (already-mounted) call UI until the
          user taps through. Phase A: TTS/greeting still fetching. Phase B:
          fetch settled, waiting on the user gesture autoplay requires. */}
      {!userTapped && (
        <div className="absolute inset-0 bg-void flex flex-col items-center justify-center gap-6 z-10">
          <div className="w-40 h-40 rounded-full bg-elevated animate-pulse" />
          <div className="text-center">
            <h2 className="text-xl font-semibold text-text-primary mb-1">
              {personaName}
            </h2>
            {!warmupDone ? (
              <p className="text-text-secondary text-sm flex items-center gap-1 justify-center">
                Connecting
                <span className="animate-pulse">...</span>
              </p>
            ) : (
              <button
                onClick={() => {
                  setUserTapped(true);
                  // User gesture: resume AudioContext then play the greeting.
                  const ctx = getAudioContext();
                  ctx.resume().then(() => tryPlayGreeting());
                }}
                className="mt-3 bg-accent hover:bg-accent/90 text-white px-8 py-3 rounded-full font-medium text-lg transition-all animate-pulse"
              >
                Tap to connect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
