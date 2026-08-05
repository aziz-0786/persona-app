"use client";

type ConvState = "idle" | "listening" | "thinking" | "speaking";

interface WallpaperCallProps {
  persona: { name: string; photoUrl?: string | null; relationship?: string | null };
  state: ConvState;
  emotion: string;
  elapsedSeconds: number;
  muted: boolean;
  onMuteToggle: () => void;
  onEndCall: () => void;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  liveCaption?: string; // current interim Deepgram transcript
}

// Deterministic gradient from persona name (so it's always the same color for the same persona)
function nameToGradient(name: string): string {
  const gradients = [
    "from-slate-900 via-purple-950 to-slate-900",
    "from-slate-900 via-blue-950 to-slate-900",
    "from-slate-900 via-emerald-950 to-slate-900",
    "from-slate-900 via-rose-950 to-slate-900",
    "from-slate-900 via-amber-950 to-slate-900",
    "from-slate-900 via-cyan-950 to-slate-900",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return gradients[Math.abs(hash) % gradients.length];
}

// Emotion → color for the badge
function emotionColor(emotion: string): string {
  const map: Record<string, string> = {
    happy: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    amused: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    calm: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    thinking: "bg-slate-500/20 text-slate-300 border-slate-500/30",
    sad: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
    angry: "bg-red-500/20 text-red-300 border-red-500/30",
    surprised: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  };
  return map[emotion] ?? "bg-white/10 text-white/60 border-white/20";
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Animated waveform — 9 bars, different heights and animation delays per state
function Waveform({ state }: { state: ConvState }) {
  const bars = [0.4, 0.7, 0.5, 1.0, 0.8, 0.6, 0.9, 0.5, 0.4];

  return (
    <div className="flex items-end justify-center gap-[3px] h-16 w-32">
      {bars.map((maxH, i) => {
        const delay = `${i * 0.07}s`;

        let animClass = "";
        if (state === "speaking") animClass = "animate-waveform-speak";
        else if (state === "thinking") animClass = "animate-waveform-think";
        else if (state === "listening") animClass = "animate-waveform-listen";

        return (
          <div
            key={i}
            className={`w-[6px] rounded-full transition-all duration-300 ${animClass}`}
            style={{
              height: `${maxH * 64}px`,
              backgroundColor:
                state === "speaking"
                  ? "rgba(255,255,255,0.85)"
                  : state === "thinking"
                  ? "rgba(255,255,255,0.35)"
                  : "rgba(255,255,255,0.25)",
              animationDelay: delay,
              maxHeight: `${maxH * 64}px`,
            }}
          />
        );
      })}
    </div>
  );
}

// Always-on status indicator — replaces the old push-to-talk mic button as
// the primary visual feedback for what the system is doing right now.
function StatusIndicator({ state, personaName }: { state: ConvState; personaName: string }) {
  if (state === "speaking") {
    return (
      <>
        <Waveform state={state} />
        <p className="text-white font-medium text-sm tracking-wide">{personaName}</p>
      </>
    );
  }

  if (state === "thinking") {
    return (
      <>
        <div className="flex gap-1.5 items-center h-16">
          <span className="w-2.5 h-2.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="w-2.5 h-2.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="w-2.5 h-2.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
        <p className="text-white/50 text-sm tracking-wide">Thinking...</p>
      </>
    );
  }

  // "listening" and "idle" (the brief pre-connect moment) share this look —
  // in an always-on call there's no meaningful third visual state, the mic
  // is always either actively picking up speech or passively ready to.
  return (
    <>
      <div
        className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"
        style={{ boxShadow: "0 0 12px rgba(52,211,153,0.8)" }}
      />
      <p className="text-white/50 text-sm tracking-wide">Listening...</p>
    </>
  );
}

export default function WallpaperCall({
  persona,
  state,
  emotion,
  elapsedSeconds,
  muted,
  onMuteToggle,
  onEndCall,
  history,
  liveCaption,
}: WallpaperCallProps) {
  const gradient = nameToGradient(persona.name);

  return (
    <div className="fixed inset-0 overflow-hidden select-none">
      {/* ── Background layer ── */}
      {persona.photoUrl ? (
        <>
          {/* Layer 1: Blurred version of the photo fills the entire screen.
              This prevents empty bars on the sides for portrait photos on desktop. */}
          <div
            className="absolute inset-0 bg-cover bg-center scale-110"
            style={{
              backgroundImage: `url(${persona.photoUrl})`,
              filter: "blur(24px)",
            }}
          />
          {/* Layer 2: Extra dark tint over the blurred fill */}
          <div className="absolute inset-0 bg-black/40" />
          {/* Layer 3: The actual photo, contained (no crop), centered.
              On mobile: fills the screen nicely (portrait = portrait, mostly matches).
              On desktop: shows the full person with blurred fill on the sides. */}
          <div
            className="absolute inset-0 bg-contain bg-center bg-no-repeat"
            style={{ backgroundImage: `url(${persona.photoUrl})` }}
          />
        </>
      ) : (
        <div className={`absolute inset-0 bg-gradient-to-br ${gradient}`} />
      )}

      {/* ── Dark veil ── */}
      <div className="absolute inset-0 bg-black/30" />

      {/* ── Content ── */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 pt-12 pb-4">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-white font-semibold text-lg leading-tight">{persona.name}</p>
              {persona.relationship && (
                <p className="text-white/50 text-xs">{persona.relationship}</p>
              )}
            </div>
            {emotion && emotion !== "default" && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${emotionColor(emotion)}`}
              >
                {emotion}
              </span>
            )}
          </div>
          <span className="text-white/60 text-sm font-mono tabular-nums">
            {formatTime(elapsedSeconds)}
          </span>
        </div>

        {/* Center: always-visible status indicator */}
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <StatusIndicator state={state} personaName={persona.name} />
        </div>

        {/* Transcript overlay — only shown when history has content OR live caption active */}
        {((history && history.length > 0) || liveCaption) && (
          <div className="absolute bottom-28 left-0 right-0 px-4 max-h-48 overflow-y-auto flex flex-col gap-2 pointer-events-none">
            {/* Conversation history bubbles — last 4 turns max */}
            {(history ?? []).slice(-4).map((turn, i) => (
              <div key={i} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed shadow-lg ${
                    turn.role === "user"
                      ? "bg-white/20 backdrop-blur-sm text-white rounded-br-sm"
                      : "bg-black/40 backdrop-blur-sm text-white rounded-bl-sm"
                  }`}
                >
                  {turn.content}
                </div>
              </div>
            ))}

            {/* Live caption — what's being heard right now */}
            {liveCaption && (
              <div className="flex justify-end">
                <div className="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm text-sm bg-white/10 backdrop-blur-sm text-white/70 italic border border-white/15">
                  {liveCaption}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bottom bar: buttons */}
        <div className="pb-12 px-5">
          <div className="flex items-center justify-center gap-6">
            {/* Mute button */}
            <button
              onClick={onMuteToggle}
              className={`
                w-16 h-16 rounded-full flex items-center justify-center text-2xl
                transition-all duration-200 active:scale-95 cursor-pointer
                ${muted
                  ? "bg-red-500/20 text-red-400 border border-red-500/40"
                  : "bg-white/15 text-white border border-white/20"
                }
              `}
            >
              {muted ? "🔇" : "🎤"}
            </button>

            {/* End call button */}
            <button
              onClick={onEndCall}
              className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 active:scale-95
                         flex items-center justify-center text-white text-2xl
                         transition-all duration-200 shadow-lg shadow-red-600/30"
            >
              📞
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
