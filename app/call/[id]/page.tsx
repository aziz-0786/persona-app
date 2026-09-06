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

// Always-on (Gemini Live style) architecture: vad_events=true turns on
// SpeechStarted (barge-in trigger) and UtteranceEnd (the actual turn
// boundary now — is_final Results are only ACCUMULATED, never submitted
// directly; see ws.onmessage). utterance_end_ms=1000 — shorter than the
// previous push-to-talk tuning (2000ms) since there's no manual stop-click
// to wait for anymore; the system itself must recognize the pause.
// endpointing=300 — Deepgram's recommended value for conversational agents
// (was 1500). Only governs is_final timing within Results, not turn
// submission (that's UtteranceEnd above), so lowering it just makes
// interim→final transcript chunks resolve faster without affecting when a
// turn is considered "done".
//
// Built per-connection rather than a static string so it can include
// keyterm= boosts for the persona's name and the user's display name —
// Deepgram's nova-3 "Keyterm Prompting" (docs claim up to ~90% recall
// improvement on boosted terms). Both names are read from refs at connect
// time rather than awaited: neither the persona fetch (usePersona) nor the
// /api/users/me fetch below is allowed to delay opening the WebSocket, so a
// name that hasn't loaded yet is just silently omitted from this connection
// instead of blocking mic/call startup for it.
function buildDeepgramWsUrl(personaName?: string | null, userName?: string | null): string {
  const params = new URLSearchParams({
    model: "nova-3",
    interim_results: "true",
    smart_format: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    vad_events: "true",
  });
  params.append("keyterm", "Lyra");
  if (personaName) params.append("keyterm", personaName);
  if (userName) params.append("keyterm", userName);
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

// Deepgram closes a connection after ~10-12s with no data at all. With
// always-on streaming this fires far less often than under push-to-talk
// (audio is continuously forwarded whenever not muted), but KeepAlive still
// covers the muted case.
const KEEPALIVE_INTERVAL_MS = 8_000;

const FILLERS = ["Hmm...", "Yeah...", "Ah, okay...", "Right...", "Got it...", "Mm-hmm..."];

export default function CallPage() {
  const { id: personaId } = useParams<{ id: string }>();
  const router = useRouter();
  const { persona } = usePersona(personaId);
  const personaName = persona?.name ?? "...";
  // Best-effort, for Deepgram keyterm boosting only (see buildDeepgramWsUrl)
  // — fetched in parallel with everything else on mount, never awaited by
  // connectDeepgram. Read as a ref (not state) since it's only ever read
  // once, at WS-connect time, and doesn't need to trigger a re-render.
  const userDisplayNameRef = useRef<string | null>(null);

  const [state, setState] = useState<ConvState>("idle");
  const [emotion, setEmotion] = useState("calm");
  const [muted, setMuted] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [micError, setMicError] = useState<string | null>(null);
  const [interimText, setInterimText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  // Reactive mirror of historyRef — historyRef itself is a plain ref (used
  // for reading the latest value synchronously inside submitTurn/endCall
  // without a stale closure), so mutating it alone never triggers a
  // re-render. WallpaperCall's transcript overlay needs an actual state
  // update to show new turns, hence this pairing (same ref+state mirror
  // pattern as stateRef/state above).
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [warmupDone, setWarmupDone] = useState(false);
  // Gates the mic on the LLM pre-warm (Postgres pool + persona cache), not
  // just the Deepgram connection — without this, the first real turn was
  // the one absorbing a Neon cold-start of several seconds. Mirrored into a
  // ref for the same reason stateRef mirrors state: ws.onopen is a callback
  // registered once and would otherwise close over a stale `false`.
  const [warmupReady, setWarmupReady] = useState(false);
  const warmupReadyRef = useRef(false);
  // True once the Deepgram WS is open AND mic permission/stream are ready —
  // independent of warmupReadyRef, so whichever of the two finishes last is
  // the one that actually arms the mic (see maybeArmMic).
  const micGateRef = useRef(false);
  const greetingAudioRef = useRef<string | null>(null);
  const greetingPlayedRef = useRef(false);

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
  // Always-on: mic capture never stops, and forwarding is armed exactly once
  // (ws.onopen, once the mic stream exists) and never disarmed again except
  // by mutedRef — there is no more "off during thinking/speaking" gating,
  // since Deepgram must keep hearing the user even while the persona talks
  // in order to detect a barge-in (SpeechStarted).
  const sendAudioRef = useRef(false);
  // Separate from sendAudioRef: sendAudioRef tracks "are we set up to send
  // at all", mutedRef tracks the user's explicit mute toggle. Checked first,
  // in ondataavailable, so muting never depends on any other state.
  const mutedRef = useRef(false);
  const keepAliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const historyRef = useRef<HistoryTurn[]>([]);
  // Accumulated across turns, sent as emotionHistory on every /api/chat
  // request so Zone 2.5 (server-side mood trend) has something to read —
  // was never populated or sent at all before this, so Zone 2.5 was always
  // seeing []. Appended only when the emotion SSE event arrives for the
  // turn that's still current (same turnId guard as setEmotion below).
  const emotionHistoryRef = useRef<string[]>([]);
  // Incremented on every submitTurn call AND on every barge-in/WS-reconnect
  // — lets stale async work (a superseded turn's SSE loop or TTS chain, or
  // one invalidated by the user talking over the persona) recognize it's
  // been interrupted and stop touching state.
  const turnIdRef = useRef(0);
  // Separate controllers so aborting one never cancels the other — e.g. a
  // TTS-only failure/retry shouldn't kill an LLM stream still in progress.
  // Also what barge-in aborts directly (see handleBargein).
  const llmAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioQueue | null>(null);
  // Set whenever TTS playback actually begins (first clause's audio, or the
  // greeting) — handleBargein uses this to ignore a SpeechStarted event that
  // arrives too soon after, since that's much more likely to be ambient
  // noise / speaker bleed than a genuine interruption.
  const ttsStartedAtRef = useRef<number>(0);
  // Accumulates every is_final Results transcript for the current utterance
  // — Results no longer submit turns directly; UtteranceEnd (VAD-based,
  // vad_events=true) does, using whatever has accumulated here since the
  // last submission.
  const accumulatedTranscriptRef = useRef<string>("");
  const cleanupRef = useRef<(() => void) | null>(null);
  const commitFiredRef = useRef(false);
  // Set when a WS close arrives while the persona is mid-speech — reconnecting
  // immediately would open a fresh Deepgram socket while TTS audio is still
  // playing, capture the persona's own voice through the mic, and trigger a
  // false barge-in that cuts the response short. Consumed (and reconnect
  // actually fired) once TTS genuinely finishes — see the two queue.onended
  // sites in submitTurn and tryPlayGreeting.
  const reconnectPendingRef = useRef(false);
  const didInitRef = useRef(false);
  const deepgramCancelledRef = useRef(false);
  const micInitPromiseRef = useRef<Promise<void> | null>(null);
  const headRef = useRef<TalkingHeadInstance>(null);
  // Set once, the first time connectDeepgram's WebSocket actually opens (the
  // call becoming active) — not at component mount, which can be several
  // seconds earlier while the Deepgram token fetch/warmup TTS ping are still
  // in flight. Guarded so a later reconnect never resets it — call_
  // sessions.startedAt must reflect the original call start, not a reconnect.
  const callStartTimeRef = useRef<Date | null>(null);

  // Dedicated filler playback — deliberately NOT the shared getAudioQueue()
  // instance, so a filler clip can be hard-stopped the instant real TTS
  // audio is ready without touching (or being touched by) the main queue's
  // own state.
  const fillerCtxRef = useRef<AudioContext | null>(null);
  const fillerSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const fillerPlayingRef = useRef(false);

  // Without this, llmAbortRef/ttsAbortRef start out null and the very first
  // submitTurn() call logs "llmAbort signals: undefined" — the abort-before-
  // new-turn calls (`llmAbortRef.current?.abort()`) silently no-op on a null
  // ref, which is harmless the first time but leaves the initial state
  // inconsistent with every turn after it (which always has a real
  // controller to abort).
  useEffect(() => {
    llmAbortRef.current = new AbortController();
    ttsAbortRef.current = new AbortController();
  }, []);

  // Fire-and-forget, purely for Deepgram keyterm boosting (see
  // buildDeepgramWsUrl) — never awaited, and a failure here just means the
  // WS connects without a user-name keyterm, nothing else depends on it.
  useEffect(() => {
    fetch("/api/users/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.displayName) userDisplayNameRef.current = data.displayName;
      })
      .catch(() => {});
  }, []);

  // Browsers block AudioContext playback until a user gesture unlocks it.
  // The old push-to-talk UI had a dedicated "Tap to connect" button that
  // doubled as that unlock; always-on has no equivalent forced interaction,
  // so this is a best-effort fallback — resume the context on the FIRST
  // pointer/key event anywhere on the page, whatever it is. If the browser
  // already allows autoplay (some do), this is a harmless no-op.
  useEffect(() => {
    function unlockAudio() {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    }
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function getFillerContext(): AudioContext {
    if (!fillerCtxRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      fillerCtxRef.current = new AudioCtx();
    }
    return fillerCtxRef.current;
  }

  function stopFiller() {
    if (fillerSourceRef.current) {
      try {
        fillerSourceRef.current.stop();
      } catch {}
      fillerSourceRef.current = null;
    }
    fillerPlayingRef.current = false;
  }

  // Fire-and-forget by design — callers never await this. Picks a random
  // short filler phrase, TTS-generates it live, and plays it on its own
  // AudioContext. Any failure (network, TTS error, decode) is swallowed
  // silently — filler is a nice-to-have, never allowed to surface an error.
  async function playFiller() {
    try {
      const text = FILLERS[Math.floor(Math.random() * FILLERS.length)];
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId, text, emotion: "calm" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.audio_base64) return;

      const ctx = getFillerContext();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const buffer = await decodeB64ToAudioBuffer(data.audio_base64, ctx);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (fillerSourceRef.current === source) {
          fillerSourceRef.current = null;
          fillerPlayingRef.current = false;
        }
      };
      fillerSourceRef.current = source;
      fillerPlayingRef.current = true;
      source.start();
    } catch {
      // Silently ignore — filler is optional.
    }
  }

  // Triggered by Deepgram's SpeechStarted event (the user talking over the
  // persona). Only meaningful while the persona is actively "speaking" —
  // during "thinking" there's no audio playing yet to interrupt, so a
  // SpeechStarted then is left alone (the in-flight LLM call is NOT
  // aborted); a SpeechStarted while idle/listening is just normal speech.
  function handleBargein() {
    if (stateRef.current !== "speaking") return;
    // Ignore SpeechStarted events in the first 600ms of TTS playback — a
    // burst of background noise (fan, ambient sound) right as audio starts
    // is far more likely than a genuine interruption that fast; a real
    // barge-in later in the same response still aborts normally.
    const msSinceTTSStarted = Date.now() - ttsStartedAtRef.current;
    if (msSinceTTSStarted < 600) {
      console.log("[CALL] barge-in ignored —", msSinceTTSStarted, "ms since TTS started, likely noise");
      return;
    }
    console.log("[CALL] barge-in — aborting in-flight requests");
    llmAbortRef.current?.abort();
    ttsAbortRef.current?.abort();
    audioQueueRef.current?.stop();
    stopFiller();
    setConvState("listening");
    accumulatedTranscriptRef.current = "";
    turnIdRef.current++; // invalidate in-flight turn
  }

  // ── Turn pipeline: /api/chat SSE → clause splitter → /api/tts → audio queue
  async function submitTurn(transcript: string) {
    if (!transcript || transcript.trim().length < 3) {
      console.log("[CALL] transcript too short, ignoring:", JSON.stringify(transcript));
      setConvState("listening");
      return;
    }
    const trimmed = transcript.trim();

    const myTurnId = ++turnIdRef.current;
    console.log("[CALL] turn", myTurnId, "started:", transcript.slice(0, 30));
    const myLlmController = new AbortController();
    const myTtsController = new AbortController();
    let ctx: AudioContext;

    try {
      // A new turn always supersedes whatever the previous one was doing —
      // both its LLM stream and its TTS fetches are stale now.
      llmAbortRef.current?.abort();
      ttsAbortRef.current?.abort();
      // Small yield to let abort propagate (in-flight fetch catch blocks /
      // AbortError early-returns) before this turn's own work begins —
      // otherwise an echo-triggered turn can start running its own
      // fetch/TTS chain in parallel with the turn it just superseded.
      await new Promise((resolve) => setTimeout(resolve, 10));
      llmAbortRef.current = myLlmController;
      ttsAbortRef.current = myTtsController;

      historyRef.current = [...historyRef.current, { role: "user", content: trimmed }];
      setHistory(historyRef.current);
      setInterimText("");
      setConvState("thinking");

      ctx = getAudioContext();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      getAudioQueue().stop();
    } catch (err) {
      console.error("[TURN] submitTurn setup failed:", err);
      if (turnIdRef.current === myTurnId) setConvState("listening");
      return;
    }

    let firstTokenSeen = false;
    let firstAudioSeen = false;
    let fullText = "";
    let clauseBuffer = "";
    let liveEmotion = "calm";
    let voiceMissing = false;
    let anyClauseAttempted = false;
    let ttsChain: Promise<void> = Promise.resolve();
    // Guards against AudioQueue.onended firing more than once for the same
    // turn (observed as two consecutive "onComplete fired" logs) — without
    // this, the listening transition below could run twice for one turn.
    let completeFired = false;

    function flushClause(clauseText: string) {
      const clause = clauseText.trim();
      if (!clause || voiceMissing) return;
      // flushClause is invoked via clauses.forEach(flushClause), not a real
      // loop — `return` here (skipping just this clause's TTS fetch) is the
      // equivalent of "break" in that context.
      if (turnIdRef.current !== myTurnId) {
        console.log("[CALL] turn", myTurnId, "superseded, aborting TTS");
        return;
      }
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
          // Real audio is ready — the filler (if still playing) has served
          // its purpose.
          fillerPlayingRef.current = false;
          stopFiller();
          ttsStartedAtRef.current = Date.now();
          setConvState("speaking");
          queue.onended(() => {
            if (completeFired) return;
            completeFired = true;
            if (turnIdRef.current !== myTurnId) {
              console.log("[CALL] turn", myTurnId, "superseded, skipping listening reset");
              return;
            }
            // Always-on: go straight back to "listening", not "idle" — the
            // mic never stopped forwarding, so there's nothing to re-arm.
            setConvState("listening");
            // Fire a reconnect that a WS close deferred while this turn's
            // audio was still playing — see ws.onclose.
            if (reconnectPendingRef.current && !deepgramCancelledRef.current) {
              reconnectPendingRef.current = false;
              connectDeepgram();
            }
          });
        }
        queue.add(buffer);
      });
    }

    try {
      const chatFetchPromise = fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: myLlmController.signal,
        body: JSON.stringify({
          personaId,
          message: trimmed,
          history: historyRef.current.slice(-6),
          emotionHistory: emotionHistoryRef.current,
        }),
      });

      const res = await chatFetchPromise;

      if (turnIdRef.current !== myTurnId) {
        console.log("[CALL] turn", myTurnId, "superseded, aborting LLM");
        return;
      }

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
              if (turnIdRef.current === myTurnId) {
                setEmotion(parsed.emotion);
                emotionHistoryRef.current = [...emotionHistoryRef.current, parsed.emotion].slice(-10);
              }
            } else if (parsed.type === "error") {
              if (turnIdRef.current === myTurnId) setConvState("listening");
              return;
            } else if (parsed.content) {
              if (!firstTokenSeen) firstTokenSeen = true;
              fullText += parsed.content;
              clauseBuffer += parsed.content;

              const clauses = extractClauses(clauseBuffer);
              if (clauses.length > 0) {
                clauseBuffer = clauseBuffer.slice(clauses.join("").length);
                clauses.forEach(flushClause);
              }

              // Hard-flush fallback: extractClauses only returns text once a
              // boundary punctuation + word-count gate is hit, so a long
              // stretch with no boundary would otherwise sit unflushed until
              // the whole SSE stream ends. Flush what's accumulated so far
              // once it crosses 200 chars rather than let it grow unbounded.
              if (clauseBuffer.length > 200) {
                flushClause(clauseBuffer);
                clauseBuffer = "";
              }
            }
          } catch {}
        }
      }

      if (clauseBuffer.trim()) flushClause(clauseBuffer);
      if (turnIdRef.current === myTurnId && fullText.trim()) {
        historyRef.current = [...historyRef.current, { role: "assistant", content: fullText }];
        setHistory(historyRef.current);
      }

      // Not awaited — if TTS is still mid cold-start, the turn shouldn't
      // block. Once every clause fetch has settled, fall back to listening
      // only if audio never actually started (e.g. TTS failed, or no voice
      // ref).
      ttsChain.then(() => {
        if (turnIdRef.current === myTurnId && !firstAudioSeen) {
          fillerPlayingRef.current = false;
          stopFiller();
          setConvState("listening");
          if (anyClauseAttempted) {
            console.error("[TTS] all clauses failed for turn, no audio queued");
            setMicError("Voice failed — try again");
          }
        }
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // interrupted or superseded
      console.error("[TURN] submitTurn failed:", err);
      if (turnIdRef.current === myTurnId) {
        fillerPlayingRef.current = false;
        stopFiller();
        setConvState("listening");
      }
    }
  }

  // Arms the mic (starts forwarding audio to Deepgram) only once BOTH the
  // WS/mic-permission side and the LLM warmup side are ready — whichever
  // finishes last calls this and actually flips sendAudioRef. No-ops if
  // called before both are ready, or if already armed.
  function maybeArmMic() {
    if (!micGateRef.current || !warmupReadyRef.current) return;
    if (sendAudioRef.current) return;
    sendAudioRef.current = true;
    if (stateRef.current === "idle") setConvState("listening");
    // Auto-play the greeting once both the mic/WS are ready and the
    // greeting TTS fetch (fired on persona load) has settled.
    if (warmupDone) tryPlayGreeting();
  }

  function markWarmupReady() {
    if (warmupReadyRef.current) return;
    warmupReadyRef.current = true;
    setWarmupReady(true);
    maybeArmMic();
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
      const ws = new WebSocket(
        buildDeepgramWsUrl(persona?.name, userDisplayNameRef.current),
        ["token", tokenData.token]
      );

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

        if (msg.type === "SpeechStarted") {
          console.log("[CALL] SpeechStarted — user speaking");
          handleBargein();
          return;
        }

        if (msg.type === "UtteranceEnd") {
          console.log("[CALL] UtteranceEnd — submitting turn");
          const transcript = accumulatedTranscriptRef.current.trim();
          accumulatedTranscriptRef.current = "";
          if (transcript.length >= 3) {
            if (Math.random() < 0.35) {
              playFiller(); // fire-and-forget, runs in parallel with submitTurn
            }
            submitTurn(transcript);
          }
          return;
        }

        // Only Results messages carry a transcript. Metadata etc. are
        // ignored entirely.
        if (msg.type !== "Results") {
          return;
        }

        const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";
        const isFinal = msg.is_final;

        if (!isFinal) {
          if (transcript && stateRef.current === "listening") {
            setInterimText(transcript);
          }
          return;
        }

        // Accumulate only — UtteranceEnd (VAD-based) is what actually
        // triggers submitTurn now, not is_final. Same state gate as before:
        // only accumulate while genuinely "listening" (anti-echo — the
        // persona's own TTS leaking into the mic during "speaking" must not
        // get accumulated into the next turn).
        if (stateRef.current === "listening" && transcript.trim()) {
          accumulatedTranscriptRef.current += " " + transcript.trim();
        }
      };
      // Without this, a transient WS error (e.g. a brief handshake hiccup)
      // leaves micError stuck true forever — there was no path back to null.
      ws.onopen = () => {
        if (!callStartTimeRef.current) callStartTimeRef.current = new Date();
        setMicError(null);
        setConnecting(false);
        // Always-on: mic permission requested the instant the socket is
        // ready, no click required. ensureMicReady() triggers the
        // getUserMedia permission prompt itself if this is the first
        // connection. Actually arming the mic (sendAudioRef) waits on
        // maybeArmMic — it also needs the LLM warmup to have finished.
        ensureMicReady().then(() => {
          micGateRef.current = true;
          maybeArmMic();
        });
      };
      ws.onerror = () => setMicError("Speech recognition connection error");
      wsRef.current = ws;

      ws.onclose = (event: CloseEvent) => {
        console.log("[CALL] WS closed — code:", event.code, "reason:", event.reason || "(none)", "wasClean:", event.wasClean);
        turnIdRef.current++;
        console.log("[CALL] WS reconnect, turnId advanced to", turnIdRef.current);
        if (keepAliveIntervalRef.current) {
          clearInterval(keepAliveIntervalRef.current);
          keepAliveIntervalRef.current = null;
        }
        // Deepgram closes idle/expired connections on its own — previously
        // nothing reopened the socket, so wsRef.current kept pointing at a
        // CLOSED WebSocket forever and every mic chunk after that was
        // silently dropped (line 719's readyState check never passed again).
        // Guarded on deepgramCancelledRef, not commitFiredRef — that flag
        // only gets set inside endCall(), so it would miss the "component
        // unmounted some other way" teardown path (browser back, tab close)
        // where cleanup() still runs and still closes this socket.
        // deepgramCancelledRef is set by that same cleanup() (before it
        // calls wsRef.current?.close()) regardless of which path triggered
        // it, so it correctly suppresses reconnect on every intentional
        // teardown, not just the hangup button.
        //
        // Deferred while "speaking": reconnecting immediately opened a fresh
        // socket while TTS audio was still playing, which picked up the
        // persona's own voice through the mic and fired a false barge-in
        // (SpeechStarted) that cut the response short. Held in
        // reconnectPendingRef and fired once TTS actually finishes instead.
        if (!deepgramCancelledRef.current) {
          if (stateRef.current === "speaking") {
            reconnectPendingRef.current = true;
          } else {
            connectDeepgram();
          }
        }
      };

      // Guards against a leaked interval on reconnect — without clearing the
      // previous interval first, each reconnect would leave an orphaned one
      // running forever alongside the new one.
      if (keepAliveIntervalRef.current) clearInterval(keepAliveIntervalRef.current);
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
      // back into the mic (the persona's own TTS playback) — load-bearing
      // now that mic forwarding stays on through "speaking" for barge-in
      // detection, not just a nice-to-have.
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
        if (mutedRef.current) return; // muted — drop bytes, keep WS open
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

  // De-duped via a shared promise since ws.onopen and a later reconnect
  // could otherwise call initMic() twice concurrently.
  async function ensureMicReady(): Promise<void> {
    if (micStreamRef.current) return;
    if (!micInitPromiseRef.current) {
      micInitPromiseRef.current = initMic();
    }
    await micInitPromiseRef.current;
  }

  // Plays the pre-fetched greeting. Triggered automatically once the mic/WS
  // are ready (see ws.onopen) rather than from a dedicated tap — relies on
  // the best-effort AudioContext unlock listener above for autoplay.
  async function tryPlayGreeting() {
    if (greetingPlayedRef.current) return;
    if (!greetingAudioRef.current) return;
    greetingPlayedRef.current = true;
    try {
      const ctx = getAudioContext();
      await ctx.resume(); // safe to call again, idempotent
      const buf = await decodeB64ToAudioBuffer(greetingAudioRef.current, ctx);
      ttsStartedAtRef.current = Date.now();
      setConvState("speaking");
      const queue = getAudioQueue();
      queue.onended(() => {
        setConvState("listening");
        // Fire a reconnect that a WS close deferred while the greeting's
        // audio was still playing — see ws.onclose.
        if (reconnectPendingRef.current && !deepgramCancelledRef.current) {
          reconnectPendingRef.current = false;
          connectDeepgram();
        }
      });
      queue.add(buf);
    } catch (e) {
      console.warn("[WARMUP] greeting play failed:", e);
      // Silent failure — user is already in the call UI, just no greeting.
    }
  }

  // Fires a short TTS ping the instant the persona loads, while the WS is
  // still connecting — this is what actually eliminates cold-start silence:
  // by the time the mic arms, the RunPod worker (5-8 min cold start
  // otherwise) is already warm.
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
        }
        setWarmupDone(true);
        // WS may have already opened and armed the mic while this fetch was
        // still in flight — try the greeting now if so.
        if (wsRef.current?.readyState === WebSocket.OPEN) tryPlayGreeting();
      })
      .catch(() => {
        // Even on failure, let the user in — just no greeting.
        setWarmupDone(true);
      });
    // Runs once when persona first loads — refetching on every persona
    // object identity change (e.g. an unrelated PATCH elsewhere) would
    // re-fire the greeting TTS call, which isn't the intent here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona]);

  // LLM pre-warm: exercises the Postgres pool (persona ownership lookup in
  // /api/chat) without spending a DeepSeek call — see the message ===
  // "__warmup__" guard in app/api/chat/route.ts. Unlike the Cartesia warmup
  // above, this one gates the mic (via markWarmupReady → maybeArmMic) —
  // without it, the first real turn was the one absorbing a multi-second
  // Neon cold-start instead of this throwaway ping. 22s timeout — Neon free
  // tier cold start observed at ~17s; this gives a 5s buffer so the mic
  // doesn't arm (and the user doesn't speak) while the warmup DB call is
  // still in flight, which would otherwise make the user's first real turn
  // compete with the still-connecting pool.
  useEffect(() => {
    if (!personaId) return;
    const warmupTimeout = setTimeout(() => markWarmupReady(), 22000); // was 15000, then 18000
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ personaId, message: '__warmup__', history: [], emotionHistory: [] }),
    })
      .then(() => {
        clearTimeout(warmupTimeout);
        markWarmupReady();
      })
      .catch(() => {
        clearTimeout(warmupTimeout);
        markWarmupReady();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      stopFiller();
      audioCtxRef.current?.close().catch(() => {});
      fillerCtxRef.current?.close().catch(() => {});
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
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
  }

  async function endCall() {
    // Guards the memory-commit + call-sessions POST below from firing twice
    // per call — production logs showed a duplicate /api/call-sessions POST.
    // This is the only call site wired to endCall (no useEffect cleanup or
    // beforeunload handler also calls it), so the double-fire is most likely
    // two rapid invocations of this handler itself (e.g. a double tap on the
    // hangup button before router.push unmounts the page) rather than a
    // React StrictMode double-effect artifact. Guarding here either way.
    if (commitFiredRef.current) return;
    commitFiredRef.current = true;

    // Fire memory commit — fire-and-forget, never blocks navigation. Was
    // previously `await`ed with a bare `catch {}`, which (a) stalled hangup
    // for as long as the DeepSeek/Groq extraction call took, and (b)
    // silently swallowed any failure (401, 500, network) with zero
    // visibility — a real error looked identical to "nothing happened."
    if (historyRef.current.length > 0) {
      fetch("/api/memory/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personaId,
          transcript: historyRef.current.map((t) => `${t.role}: ${t.content}`).join("\n"),
        }),
      }).catch((err) => console.error("[MEMORY COMMIT]", err));
    }

    cleanupRef.current?.();

    // Fire-and-forget — a DB failure here must never block navigation back
    // to the dashboard. Client component: goes through /api/call-sessions
    // rather than importing `db` directly.
    if (historyRef.current.length > 0) {
      const startedAt = callStartTimeRef.current ?? new Date();
      const endedAt = new Date();
      fetch("/api/call-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personaId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationSeconds: Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
          turnCount: historyRef.current.length,
          transcriptJson: historyRef.current,
        }),
      }).catch((err) => console.error("[CALL SESSION]", err));
    }

    router.push("/");
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <WallpaperCall
        persona={{
          name: personaName,
          photoUrl: persona?.photoUrl,
          relationship: persona?.relationship,
        }}
        state={state}
        emotion={emotion}
        elapsedSeconds={elapsed}
        muted={muted}
        onMuteToggle={toggleMute}
        onEndCall={endCall}
        history={history}
        liveCaption={interimText}
      />

      {/* Connecting overlay — disappears automatically once the Deepgram WS
          is open AND the LLM warmup has finished (see maybeArmMic), no tap
          required. Same visual for both reasons — a few extra seconds of
          "Connecting..." reads fine; a first turn silently eating a Neon
          cold-start doesn't. */}
      {(connecting || !warmupReady) && (
        <div className="absolute inset-0 bg-void flex flex-col items-center justify-center gap-6 z-10">
          <div className="w-40 h-40 rounded-full bg-elevated animate-pulse" />
          <div className="text-center">
            <h2 className="text-xl font-semibold text-text-primary mb-1">{personaName}</h2>
            <p className="text-text-secondary text-sm flex items-center gap-1 justify-center">
              Connecting
              <span className="animate-pulse">...</span>
            </p>
          </div>
        </div>
      )}

      {micError && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%',
          transform: 'translateX(-50%)',
          background: '#7f1d1d', color: '#fca5a5',
          padding: '8px 16px', borderRadius: '8px',
          fontSize: '14px', zIndex: 50
        }}>
          {micError}
        </div>
      )}
    </div>
  );
}
