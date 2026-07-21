"use client";
import { useState, useRef, useEffect } from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui";
import { cn, EMOTION_EMOJI } from "@/lib/utils";
import { usePersona } from "@/lib/hooks";
import { decodeB64ToAudioBuffer, createAudioQueue, extractClauses, type AudioQueue } from "@/lib/audio";
import { Send, Volume2, Phone, Loader2 } from "lucide-react";
import Link from "next/link";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  emotion?: string;
  audioB64?: string;
  isError?: boolean;
  ttsError?: string;
  // Set once a TTS fetch for this message has failed — swaps the Play
  // button for a "Playback failed" + Retry row.
  ttsFailed?: boolean;
  // True while a /api/tts fetch for this message is in flight but no audio
  // has started playing yet — drives the Play button's loading spinner.
  ttsLoading?: boolean;
  // True once a single /api/tts fetch has been in flight for >10s — RunPod
  // cold starts take 5-8 min, so this tells the user it's not stuck.
  warmingUp?: boolean;
};

// A single /api/tts fetch taking longer than this is almost certainly a
// RunPod cold start, not a stalled request — surface the warming-up notice.
const TTS_WARMUP_THRESHOLD_MS = 10_000;

// Must stay above the server's RunPod LLM timeout (45s) plus real cold-start
// margin — a client deadline shorter than what the server will legitimately
// wait for fires a false "no response" error while the LLM is still working.
const CLIENT_TIMEOUT_MS = 90_000;

export default function ChatPage() {
  const { id: personaId } = useParams<{ id: string }>();
  const { persona } = usePersona(personaId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const clientTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioQueue | null>(null);
  // Which assistant message the live clause-streamed queue is currently
  // playing for — lets a manual Play click or a new send invalidate any
  // clause audio still trickling in for a superseded response.
  const activeStreamIdRef = useRef<string | null>(null);

  const personaName = persona?.name ?? "...";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // On unmount: stop audio, cancel any in-flight stream read, abort the
  // fetch, and clear the client-side deadline — avoids "state update on
  // unmounted component" if the user navigates away mid-response.
  useEffect(() => {
    return () => {
      audioQueueRef.current?.stop();
      audioCtxRef.current?.close().catch(() => {});
      readerRef.current?.cancel().catch(() => {});
      abortRef.current?.abort();
      if (clientTimeoutRef.current) clearTimeout(clientTimeoutRef.current);
    };
  }, []);

  // Lazy AudioContext, created on first use inside a user-gesture handler
  // (browsers block autoplay otherwise).
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
      audioQueueRef.current = createAudioQueue(getAudioContext());
    }
    return audioQueueRef.current;
  }

  function clearClientTimeout() {
    if (clientTimeoutRef.current) {
      clearTimeout(clientTimeoutRef.current);
      clientTimeoutRef.current = null;
    }
  }

  function patchMessage(id: string, patch: Partial<Message>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  type TtsFetchResult = { audioB64: string } | { error: string; status: number };

  // Shared by both the clause-streamed auto-play path and the manual
  // Play/Retry button — tracks the >10s cold-start warming indicator so
  // callers don't have to duplicate the timer bookkeeping.
  async function fetchTtsAudio(
    messageId: string,
    payload: { personaId: string; text: string; emotion?: string }
  ): Promise<TtsFetchResult> {
    const warmupTimer = setTimeout(
      () => patchMessage(messageId, { warmingUp: true }),
      TTS_WARMUP_THRESHOLD_MS
    );
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error || !data.audio_base64) {
        return { error: data.error ?? `TTS HTTP ${res.status}`, status: res.status };
      }
      return { audioB64: data.audio_base64 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "TTS failed", status: 0 };
    } finally {
      clearTimeout(warmupTimer);
      patchMessage(messageId, { warmingUp: false });
    }
  }

  async function sendMessage() {
    if (!input.trim() || isLoading) return;
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    const assistantId = (Date.now() + 1).toString();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", emotion: "thinking" },
    ]);

    abortRef.current = new AbortController();

    // Called synchronously from the Send button's click — safe to touch
    // AudioContext here (before any `await`) to satisfy browser autoplay
    // gesture requirements for the clause-streamed audio started below.
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    getAudioQueue().stop();
    activeStreamIdRef.current = assistantId;

    // ── Clause-level streaming TTS: speak sentences as they finish
    // generating instead of waiting for the whole response. Foundation for
    // the live call page (Phase 5) — best-effort, never surfaces errors.
    let clauseBuffer = "";
    let liveEmotion = "calm";
    let voiceMissing = false;
    let ttsChain: Promise<void> = Promise.resolve();
    let playbackStarted = false;

    function flushClause(clauseText: string) {
      const trimmed = clauseText.trim();
      if (!trimmed || voiceMissing) return;

      // Only meaningful before the first clause has actually started playing
      // — once audio is flowing, "Playing..." already communicates progress.
      if (!playbackStarted) patchMessage(assistantId, { ttsLoading: true });

      const fetchPromise = (async (): Promise<AudioBuffer | null> => {
        const result = await fetchTtsAudio(assistantId, { personaId, text: trimmed, emotion: liveEmotion });
        if ("error" in result) {
          if (result.status === 422) voiceMissing = true;
          return null;
        }
        try {
          return await decodeB64ToAudioBuffer(result.audioB64, ctx);
        } catch {
          return null;
        }
      })();

      // Fetches run concurrently for latency, but the chain guarantees
      // clauses are queued in the order they were generated, not the order
      // their network requests happen to resolve in.
      ttsChain = ttsChain.then(async () => {
        const buffer = await fetchPromise;
        if (!buffer || activeStreamIdRef.current !== assistantId) return;
        const queue = getAudioQueue();
        if (!playbackStarted) {
          playbackStarted = true;
          patchMessage(assistantId, { ttsLoading: false });
          setPlayingId(assistantId);
          queue.onended(() => setPlayingId((id) => (id === assistantId ? null : id)));
        }
        queue.add(buffer);
      });
    }

    // Client-side deadline independent of the server: even if the server
    // hangs or the connection drops silently, the UI must recover.
    clientTimeoutRef.current = setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: "⚠ No response received. Check RunPod or enable stub mode.",
                isError: true,
                emotion: undefined,
              }
            : m
        )
      );
      setIsLoading(false);
      abortRef.current?.abort();
    }, CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          personaId,
          message: userMsg.content,
          // Last 6 turns of history, sent with every request
          history: messages.slice(-6).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let fullText = "";
      let detectedEmotion = "calm";
      // SSE events are separated by a blank line ("\n\n"). A single event
      // can arrive split across multiple reader.read() chunks, so buffer
      // and only parse complete events — never split/parse mid-event, or
      // adjacent tokens end up concatenated or truncated mid-word.
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() ?? ""; // incomplete trailing event — wait for more data

        for (const event of events) {
          const line = event.replace(/^data: /, "").trim();
          if (!line || line === "[DONE]") continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "emotion") {
              detectedEmotion = parsed.emotion;
              liveEmotion = parsed.emotion;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, emotion: parsed.emotion } : m
                )
              );
            } else if (parsed.type === "error") {
              clearClientTimeout();
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: `⚠ ${parsed.message}`, isError: true, emotion: undefined }
                    : m
                )
              );
              setIsLoading(false);
            } else if (parsed.content) {
              clearClientTimeout();
              fullText += parsed.content;
              clauseBuffer += parsed.content;

              const clauses = extractClauses(clauseBuffer);
              if (clauses.length > 0) {
                clauseBuffer = clauseBuffer.slice(clauses.join("").length);
                clauses.forEach(flushClause);
              }

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: fullText, emotion: detectedEmotion }
                    : m
                )
              );
            }
          } catch {}
        }
      }

      // Speak whatever trailing fragment never hit a clause boundary.
      if (clauseBuffer.trim()) flushClause(clauseBuffer);

      // Not awaited — sendMessage must finish (and clear isLoading) even if
      // TTS is still mid cold-start. Once every clause fetch has settled,
      // surface a failure state only if audio never actually started.
      ttsChain.then(() => {
        if (activeStreamIdRef.current !== assistantId || playbackStarted) return;
        if (voiceMissing) {
          patchMessage(assistantId, {
            ttsLoading: false,
            ttsError: "No voice reference. Go to Create → Voice tab to record one.",
            ttsFailed: true,
          });
        } else if (fullText.trim()) {
          patchMessage(assistantId, { ttsLoading: false, ttsError: "Playback failed", ttsFailed: true });
        }
      });

      clearClientTimeout();
    } catch (err) {
      clearClientTimeout();
      if ((err as Error).name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Something went wrong. Try again.", isError: true, emotion: undefined }
            : m
        )
      );
    } finally {
      readerRef.current = null;
      setIsLoading(false);
    }
  }

  // Used for both the initial Play click and the explicit Retry button —
  // Retry re-sends the same text to /api/tts since there's no cached failed
  // audio to fall back on.
  async function playAudio(msg: Message) {
    if (playingId === msg.id) return;

    // Interrupt anything else in flight — a manual Play/Retry always wins.
    activeStreamIdRef.current = null;
    audioQueueRef.current?.stop(); // stop any live clause-streamed audio, if playing
    patchMessage(msg.id, { ttsError: undefined, ttsFailed: false });

    let audioB64 = msg.audioB64;
    if (!audioB64) {
      patchMessage(msg.id, { ttsLoading: true });
      const result = await fetchTtsAudio(msg.id, { personaId, text: msg.content, emotion: msg.emotion });
      patchMessage(msg.id, { ttsLoading: false });

      if ("error" in result) {
        patchMessage(msg.id, { ttsError: result.error || "Playback failed", ttsFailed: true });
        return;
      }
      audioB64 = result.audioB64;
      patchMessage(msg.id, { audioB64 });
    }

    try {
      setPlayingId(msg.id);

      const audioUrl = `data:audio/wav;base64,${audioB64}`;
      const audio = new Audio(audioUrl);
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = (e) => reject(new Error(`Audio decode error: ${e}`));
        audio.play().catch(reject);
      });

      setPlayingId((id) => (id === msg.id ? null : id));
    } catch {
      // Playback failure (not a fetch failure) — audioB64 is still cached
      // and valid, so this does NOT set ttsFailed; replaying is fine.
      setPlayingId(null);
      patchMessage(msg.id, { ttsError: "Playback failed" });
    }
  }

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-8rem)] max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-elevated flex items-center justify-center flex-shrink-0 overflow-hidden">
              {persona?.avatarType === "avaturn" && persona.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={persona.avatarUrl} alt={personaName} className="w-full h-full object-cover" />
              ) : (
                <span className="text-sm font-display font-bold text-text-muted">
                  {personaName[0]?.toUpperCase() ?? "?"}
                </span>
              )}
            </div>
            <div>
              <h1 className="font-display font-semibold text-text-primary">{personaName}</h1>
              <p className="text-xs text-text-muted">Text chat</p>
            </div>
          </div>
          <Link
            href={`/call/${personaId}`}
            className="flex items-center gap-1.5 px-3 py-2 bg-accent/10 hover:bg-accent/20 text-accent text-sm font-medium rounded-lg transition-colors"
          >
            <Phone size={13} />
            Switch to call
          </Link>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3">
              <span className="text-4xl">💬</span>
              <p className="text-sm text-text-muted">
                Start a conversation with {personaName}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm",
                  msg.role === "user"
                    ? "bg-accent text-white rounded-br-sm"
                    : msg.isError
                      ? "bg-error/10 border border-error/30 text-error rounded-bl-sm"
                      : "bg-surface border border-border text-text-primary rounded-bl-sm"
                )}
              >
                {msg.role === "assistant" && msg.emotion && (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-xs">{EMOTION_EMOJI[msg.emotion] ?? "😌"}</span>
                    <span className="text-xs text-text-muted capitalize">{msg.emotion}</span>
                  </div>
                )}
                {msg.content === "" && msg.role === "assistant" ? (
                  <div className="flex gap-1 py-0.5">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
                {msg.role === "assistant" && msg.content && !msg.isError && (
                  <div className="mt-1.5">
                    {msg.ttsFailed ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-error">{msg.ttsError ?? "Playback failed"}</span>
                        <button
                          onClick={() => playAudio(msg)}
                          className="text-xs text-accent hover:underline flex-shrink-0"
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => playAudio(msg)}
                        disabled={msg.ttsLoading || (playingId !== null && playingId !== msg.id)}
                        className={cn(
                          "flex items-center gap-1.5 text-xs transition-colors",
                          playingId === msg.id
                            ? "text-accent"
                            : "text-text-muted hover:text-text-secondary"
                        )}
                      >
                        {playingId === msg.id ? (
                          <span className="flex items-end gap-0.5 h-2.5">
                            {[0, 1, 2].map((i) => (
                              <span
                                key={i}
                                className="w-0.5 bg-accent rounded-full animate-pulse"
                                style={{ height: `${4 + i * 3}px`, animationDelay: `${i * 0.15}s` }}
                              />
                            ))}
                          </span>
                        ) : msg.ttsLoading ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Volume2 size={11} />
                        )}
                        {playingId === msg.id ? "Playing..." : msg.ttsLoading ? "Loading..." : "Play"}
                      </button>
                    )}
                    {!msg.ttsFailed && msg.ttsError && (
                      <p className="text-xs text-error mt-1">{msg.ttsError}</p>
                    )}
                    {msg.warmingUp && (
                      <p className="text-xs text-text-muted mt-1 italic">
                        Warming up voice model... (first response may take up to 2 min)
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="flex items-end gap-2 pt-4 border-t border-border mt-4">
          <div className="flex-1">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={`Message ${personaName}...`}
              rows={1}
              className="w-full bg-elevated border border-border rounded-xl px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-colors max-h-32"
            />
          </div>
          <Button onClick={sendMessage} loading={isLoading} disabled={!input.trim()}>
            <Send size={16} />
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
