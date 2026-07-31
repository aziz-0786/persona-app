"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Skeleton } from "@/components/ui";
import { cn, EMOTION_EMOJI } from "@/lib/utils";
import { usePersona } from "@/lib/hooks";
import { ChevronLeft, ChevronDown, ChevronUp } from "lucide-react";

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  emotion: string | null;
  isPinned: boolean;
  pinnedBy: string | null;
  autoTag: string | null;
  createdAt: string;
};

type TranscriptTurn = { role: "user" | "assistant"; content: string; timestamp: number };

type CallSessionItem = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  turnCount: number | null;
  transcriptJson: TranscriptTurn[] | null;
  summaryText: string | null;
};

type Tab = "chat" | "calls" | "pinned";

const TAG_COLORS: Record<string, string> = {
  birthday: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  meeting: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  anniversary: "bg-purple-500/10 text-purple-300 border-purple-500/30",
  personal_fact: "bg-green-500/10 text-green-300 border-green-500/30",
  reminder: "bg-amber-500/10 text-amber-300 border-amber-500/30",
};

function tagColor(tag: string | null): string {
  if (!tag) return "bg-zinc-500/10 text-zinc-300 border-zinc-500/30";
  return TAG_COLORS[tag] ?? "bg-zinc-500/10 text-zinc-300 border-zinc-500/30";
}

function formatHHMM(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCallDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s} sec`;
  return `${m} min ${s} sec`;
}

export default function HistoryPage() {
  const { personaId } = useParams<{ personaId: string }>();
  const router = useRouter();
  const { persona } = usePersona(personaId);

  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [calls, setCalls] = useState<CallSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCalls, setExpandedCalls] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const personaName = persona?.name ?? "...";

  useEffect(() => {
    if (!personaId) return;
    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetch(`/api/history/${personaId}/chat`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/history/${personaId}/calls`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([chatData, callData]) => {
        if (cancelled) return;
        setMessages(chatData);
        setCalls(callData);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [personaId]);

  function showToast(text: string) {
    setToast(text);
    setTimeout(() => setToast(null), 3000);
  }

  async function togglePin(msg: ChatMsg) {
    const prevMessages = messages;
    const nextPinned = !msg.isPinned;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id
          ? { ...m, isPinned: nextPinned, pinnedBy: nextPinned ? "user" : null }
          : m
      )
    );

    try {
      const res = await fetch(`/api/messages/${msg.id}/pin`, { method: "PATCH" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, isPinned: data.isPinned } : m))
      );
    } catch {
      setMessages(prevMessages);
      showToast("Failed to update pin");
    }
  }

  function toggleExpanded(id: string) {
    setExpandedCalls((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pinnedMessages = messages
    .filter((m) => m.isPinned)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto">
        {/* Top bar */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.back()}
            className="p-1.5 -ml-1.5 rounded-full text-text-secondary hover:text-text-primary hover:bg-elevated transition-colors flex-shrink-0"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold text-text-primary truncate">
              {personaName}
            </h1>
            {persona?.relationship && (
              <p className="text-xs text-text-muted capitalize">{persona.relationship}</p>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-6 border-b border-border mb-6">
          {(["chat", "calls", "pinned"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "pb-3 text-sm font-medium capitalize border-b-2 -mb-px transition-colors",
                tab === t
                  ? "border-accent text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-secondary"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </div>
        ) : (
          <>
            {tab === "chat" && (
              <ChatTab messages={messages} onTogglePin={togglePin} />
            )}
            {tab === "calls" && (
              <CallsTab
                calls={calls}
                expanded={expandedCalls}
                onToggleExpand={toggleExpanded}
              />
            )}
            {tab === "pinned" && (
              <PinnedTab pinned={pinnedMessages} onTogglePin={togglePin} />
            )}
          </>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-error text-white text-sm px-4 py-2 rounded-xl shadow-lg z-50">
          {toast}
        </div>
      )}
    </AppShell>
  );
}

function ChatTab({
  messages,
  onTogglePin,
}: {
  messages: ChatMsg[];
  onTogglePin: (msg: ChatMsg) => void;
}) {
  if (messages.length === 0) {
    return (
      <p className="text-sm text-text-muted text-center py-12">
        No chat history yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {messages.map((msg) =>
        msg.role === "user" ? (
          <div key={msg.id} className="flex justify-end">
            <div className="relative max-w-[75%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-purple-600 text-white shadow-lg">
              <button
                onClick={() => onTogglePin(msg)}
                className="absolute top-1 right-1 text-xs leading-none p-1"
                aria-label="Toggle pin"
              >
                <span className={msg.isPinned ? "text-yellow-400" : "text-white/40"}>📌</span>
              </button>
              <p className="text-sm leading-relaxed whitespace-pre-wrap pr-4">{msg.content}</p>
              <p className="text-xs text-white/60 mt-1 text-right">{formatHHMM(msg.createdAt)}</p>
            </div>
          </div>
        ) : (
          <div key={msg.id} className="flex justify-start">
            <div className="relative max-w-[75%] px-4 py-2.5 rounded-2xl rounded-bl-sm bg-white/15 backdrop-blur-sm border border-white/10 text-white shadow-lg">
              <button
                onClick={() => onTogglePin(msg)}
                className="absolute top-1 right-1 text-xs leading-none p-1"
                aria-label="Toggle pin"
              >
                <span className={msg.isPinned ? "text-yellow-400" : "text-zinc-600"}>📌</span>
              </button>
              {msg.emotion && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-xs">{EMOTION_EMOJI[msg.emotion] ?? "😌"}</span>
                  <span className="text-xs text-white/60 capitalize">{msg.emotion}</span>
                </div>
              )}
              <p className="text-sm leading-relaxed whitespace-pre-wrap pr-4">{msg.content}</p>
              <p className="text-xs text-white/50 mt-1">{formatHHMM(msg.createdAt)}</p>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function CallsTab({
  calls,
  expanded,
  onToggleExpand,
}: {
  calls: CallSessionItem[];
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
}) {
  if (calls.length === 0) {
    return (
      <p className="text-sm text-text-muted text-center py-12">
        No calls yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {calls.map((call) => {
        const isOpen = expanded.has(call.id);
        const hasTranscript = Array.isArray(call.transcriptJson) && call.transcriptJson.length > 0;

        return (
          <div key={call.id} className="bg-surface border border-border rounded-2xl overflow-hidden">
            <button
              onClick={() => onToggleExpand(call.id)}
              className="w-full flex items-center justify-between px-4 py-3.5 text-left"
            >
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {formatCallDate(call.startedAt)}
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  {formatDuration(call.durationSeconds)} · {call.turnCount ?? 0} exchanges
                </p>
              </div>
              {isOpen ? (
                <ChevronUp size={16} className="text-text-muted flex-shrink-0" />
              ) : (
                <ChevronDown size={16} className="text-text-muted flex-shrink-0" />
              )}
            </button>

            {isOpen && (
              <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
                {call.summaryText && (
                  <p className="text-sm text-text-muted italic">{call.summaryText}</p>
                )}

                {hasTranscript ? (
                  isTranscriptTurnArray(call.transcriptJson) ? (
                    <div className="space-y-2">
                      {call.transcriptJson!.map((turn, i) => (
                        <div
                          key={i}
                          className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}
                        >
                          <div
                            className={cn(
                              "max-w-[80%] px-3 py-2 rounded-xl text-sm leading-relaxed",
                              turn.role === "user"
                                ? "bg-purple-600/80 text-white"
                                : "bg-elevated text-text-primary"
                            )}
                          >
                            {turn.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <pre className="text-xs text-text-muted whitespace-pre-wrap bg-elevated rounded-xl p-3 overflow-x-auto">
                      {JSON.stringify(call.transcriptJson, null, 2)}
                    </pre>
                  )
                ) : (
                  <p className="text-sm text-text-muted">No transcript recorded for this session</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Confirms transcriptJson actually matches the { role, content } shape the
// call-session code writes (db/schema.ts's callSessions.transcriptJson type)
// before rendering it as chat bubbles — falls back to a raw JSON dump for
// anything else rather than crashing on an unexpected shape.
function isTranscriptTurnArray(value: unknown): value is TranscriptTurn[] {
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        t &&
        typeof t === "object" &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string"
    )
  );
}

function PinnedTab({
  pinned,
  onTogglePin,
}: {
  pinned: ChatMsg[];
  onTogglePin: (msg: ChatMsg) => void;
}) {
  if (pinned.length === 0) {
    return (
      <p className="text-sm text-text-muted text-center py-12">
        No pinned messages yet.
        <br />
        Tap 📌 on any message in Chat to save it here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {pinned.map((msg) => (
        <div
          key={msg.id}
          className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-2"
        >
          <p className="text-sm text-text-primary leading-relaxed">{msg.content}</p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {msg.autoTag && (
                <span
                  className={cn(
                    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize",
                    tagColor(msg.autoTag)
                  )}
                >
                  {msg.autoTag.replace("_", " ")}
                </span>
              )}
              <span className="text-xs text-text-muted">
                {msg.pinnedBy === "auto" ? "Auto-pinned" : "Pinned by you"}
              </span>
            </div>
            <button
              onClick={() => onTogglePin(msg)}
              className="text-yellow-400 p-1"
              aria-label="Unpin"
            >
              📌
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
