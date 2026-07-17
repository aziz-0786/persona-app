"use client";
import { useState, useRef, useEffect } from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Button, Input } from "@/components/ui";
import { cn, EMOTION_EMOJI } from "@/lib/utils";
import { Send, Volume2, Phone } from "lucide-react";
import Link from "next/link";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  emotion?: string;
  audioB64?: string;
};

export default function ChatPage() {
  const { id: personaId } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [personaName, setPersonaName] = useState("...");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/personas?id=${personaId}`)
      .then((r) => r.json())
      .then((d) => setPersonaName(d.name ?? "Persona"))
      .catch(() => {});
  }, [personaId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

    try {
      // Phase 3 will implement /api/chat SSE; stub response for now
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          personaId,
          message: userMsg.content,
          history: messages.slice(-6).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let detectedEmotion = "calm";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);

        // Parse SSE
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "emotion") {
                detectedEmotion = parsed.emotion;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, emotion: parsed.emotion } : m
                  )
                );
              } else if (parsed.content) {
                fullText += parsed.content;
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
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Something went wrong. Try again.", emotion: "calm" }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function playAudio(msg: Message) {
    if (playingId === msg.id) return;
    setPlayingId(msg.id);

    try {
      // Fetch TTS if not already fetched
      let audioB64 = msg.audioB64;
      if (!audioB64) {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personaId, text: msg.content, emotion: msg.emotion }),
        });
        const data = await res.json();
        audioB64 = data.audio_base64;
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, audioB64 } : m))
        );
      }

      if (!audioB64) return;
      const audio = new Audio(`data:audio/wav;base64,${audioB64}`);
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => setPlayingId(null);
      await audio.play();
    } catch {
      setPlayingId(null);
    }
  }

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-8rem)] max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border mb-4">
          <div>
            <h1 className="font-display font-semibold text-text-primary">
              {personaName}
            </h1>
            <p className="text-xs text-text-muted">Text chat</p>
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
                {msg.role === "assistant" && msg.content && (
                  <button
                    onClick={() => playAudio(msg)}
                    disabled={playingId !== null && playingId !== msg.id}
                    className={cn(
                      "flex items-center gap-1 mt-1.5 text-xs transition-colors",
                      playingId === msg.id
                        ? "text-accent"
                        : "text-text-muted hover:text-text-secondary"
                    )}
                  >
                    <Volume2 size={11} />
                    {playingId === msg.id ? "Playing..." : "Play"}
                  </button>
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
