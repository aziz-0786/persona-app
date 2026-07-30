# PERSONA APP — Architecture Audit

Scope: `app/call/[id]/page.tsx`, `app/chat/[id]/page.tsx`, `app/api/chat/route.ts`,
`app/api/tts/route.ts`, `app/api/warmup-runpod/route.ts`, `hooks/useWarmupManager.ts`,
`runpod-worker/handler.py`, `.env` (key names only). Read-only audit — no code changed.
Branch: `feature/warmup-latency`.

---

## 1. Call Page State Machine

`type ConvState = "idle" | "listening" | "thinking" | "speaking";` (`app/call/[id]/page.tsx:16`)

| State | Entered by | Exited by | Blocked while in this state |
|---|---|---|---|
| `idle` | Initial mount default. `AudioQueue.onended` in `submitTurn` (sets `idle` immediately, then may auto-promote to `listening` 900ms later). `tryPlayGreeting`'s `onended`. Any turn-failure path (`empty message`, `submitTurn setup failed`, chat SSE error/exception, all-TTS-clauses-failed). | User clicks mic (idle→listening branch), or the 900ms auto-listen timer promotes it. | Nothing explicit blocks in `idle`; it's the only state `handleMicClick`'s first branch check doesn't reject. |
| `listening` | Mic click from `idle` (`handleMicClick`, line ~727-736). Auto-promotion 900ms after audio ends (line ~306-316), if nothing else has moved the turn on. | Mic click again (listening→thinking, click-to-stop). Deepgram final accepted and `submitTurn` runs (sets `thinking` internally). | `handleMicClick` no-ops if `isMuted \|\| state === "thinking" \|\| state === "speaking"` — `listening` itself is never blocked from being clicked out of. |
| `thinking` | `submitTurn`'s setup block (line 200), immediately after abort/history bookkeeping. Click-to-stop branch of `handleMicClick` (line 691), synchronously, before any transcript is known. | First TTS clause audio arriving → `speaking`. LLM/TTS failure paths → `idle`. Empty-transcript guard at top of `submitTurn` → `listening`. | `handleMicClick` ignores clicks entirely while `thinking`. Mic forwarding (`sendAudioRef`) is off. |
| `speaking` | First TTS clause's audio buffer ready (`flushClause`'s `ttsChain`, line 285). Greeting playback (`tryPlayGreeting`, line 581). | `AudioQueue.onended` fires → immediately `idle`, then (turn-flow only, not greeting) auto-promotes to `listening` after 900ms if uninterrupted. | `handleMicClick` ignores clicks entirely while `speaking`. Mic forwarding off (`sendAudioRef` false, plus a redundant explicit `stateRef.current === "speaking"` early-return in `ondataavailable`). |

Diagram (turn-flow path; greeting path is `speaking → idle` only, no auto-listen):

```
        (click)                  (audio ready)
idle ─────────────► listening ─────┐
 ▲                       │         │
 │ (click-to-stop        │(DG      ▼
 │  sets thinking         final) thinking ──(1st clause audio)──► speaking
 │  immediately)          │         ▲                                │
 │                        ▼         │ (empty/failed transcript)      │
 └── idle ◄───────────────┘         └─────────────────────────────── │
        ▲                                                            │
        │ (onended fires immediately)                                │
        └────────────────────────────────────────────────────────────┘
                    │
                    ▼ (+900ms, if turn/state untouched since)
               listening (auto)
```

Two mechanisms fight over `"listening"`: the manual mic-click (idle→listening) and the automatic 900ms post-speech promotion. Both can independently set it.

---

## 2. `submitTurn()` — All Call Sites

Only two call sites exist in the entire audited scope (confirmed by grep across `app/call/[id]/page.tsx`; no other file defines or calls a function named `submitTurn`):

| File | Line | Trigger | State expected at call time |
|---|---|---|---|
| `app/call/[id]/page.tsx` | 502 | Deepgram `is_final: true` message, non-empty transcript, gated by the "critical gate" | `stateRef.current === "listening"` **OR** `awaitingFinalRef.current === true` (the latter covers the normal click-to-stop case, where state has already moved to `"thinking"` by the time this fires) |
| `app/call/[id]/page.tsx` | 722 | 800ms timeout inside `handleMicClick`'s stop-click branch — fallback if Deepgram never finalizes | `awaitingFinalRef.current === true` (set `true` at the stop-click, cleared by whichever of the two paths — real final or this timeout — runs first) |

`submitTurn` itself also self-guards at its very top (line 166-170): if called with an empty/whitespace-only string, it logs and resets `stateRef`/`state` to `"listening"` without doing anything else.

No `UtteranceEnd` handler, no other `setInterval`/`setTimeout` elsewhere calls it, and the chat page (`app/chat/[id]/page.tsx`) has its own entirely separate `sendMessage()` — it does not call `submitTurn` at all (different page, different pipeline, no shared state).

---

## 3. Deepgram Message Handler

All messages arrive via one `ws.onmessage` in `connectDeepgram()` (`app/call/[id]/page.tsx:438-503`).

- **Any message where `msg.type !== "Results"`** (this is where `Metadata` and `UtteranceEnd` land): logged (`"[DG] non-Results message:", msg.type`) and returned immediately. **Neither `Metadata` nor `UtteranceEnd` ever reaches `submitTurn` or touches state.** There is no dedicated `UtteranceEnd` handling despite `utterance_end_ms=2000` being requested in the WS URL — that Deepgram feature is currently requested but unused.
- **`is_final: false`** (interim result): if there's transcript text, it's stashed in `accTranscriptRef.current` (last-interim cache, used by the 800ms fallback) and, only if `stateRef.current === "listening"`, mirrored into the `interimText` state for the live caption UI. Returns without ever considering `submitTurn`.
- **`is_final: true`**: logged, then gated by the "critical gate" — rejected unless `stateRef.current === "listening"` **or** `awaitingFinalRef.current` is true. If rejected, logged and discarded. If accepted, `awaitingFinalRef.current` is cleared, the transcript is trimmed; if empty after trim, discarded with a log; otherwise `accTranscriptRef` is cleared and `submitTurn(cleaned)` is called.

Gates before `submitTurn` on the `is_final` path, in order: (1) `msg.type === "Results"`, (2) `is_final === true`, (3) `stateRef.current === "listening" || awaitingFinalRef.current`, (4) `transcript.trim()` non-empty.

---

## 4. Audio Pipeline

`submitTurn(transcript)` → `fetch("/api/chat")` (SSE) → clause-splitter (`extractClauses`) → per-clause `fetch("/api/tts")` → `decodeB64ToAudioBuffer` → `AudioQueue.add()` → (on first clause only) `AudioQueue.onended(...)` registered → `onended` fires when the queue drains.

Failure handling per step:
- **`/api/chat` fetch throws / non-OK / no body**: caught in the outer `try/catch` (line 405-414). `AbortError` (superseded turn) returns silently. Any other error sets `lastAssistantText` to a generic failure message and `setConvState("idle")` — **not** `"listening"`; the user must click the mic again.
- **`/api/chat` SSE emits `{type: "error"}`**: sets `lastAssistantText`, `setConvState("idle")`, returns — same as above, no auto-recovery to listening.
- **A given clause's `/api/tts` fetch fails or returns no `audio_base64`**: `flushClause`'s inner `fetchPromise` catches it, logs, resolves `null`; the `ttsChain.then` skips queuing anything for that clause and moves on — one bad clause doesn't kill the turn, but if it was the *only* clause, no audio ever plays.
- **All clauses fail** (`anyClauseAttempted` true, `firstAudioSeen` never true): the `ttsChain.then(...)` epilogue (line 394-404) sets `idle` and `setMicError("Voice failed — tap to try again")`. No auto-retry.
- **422 from `/api/tts`** (persona has no voice reference): `voiceMissing` flag set, all subsequent clause attempts short-circuit (`flushClause` returns early), same "all clauses failed" epilogue applies.

**Does `onComplete` (`AudioQueue.onended`) always fire?** Only if at least one clause's audio actually started playing (`firstAudioSeen` became true), because the `onended` callback is only ever *registered* inside that first-audio branch (line 280-317). If every clause fails, `onended` is **never registered for that turn**, so it can never fire — the turn instead resolves via the "all clauses failed" epilogue above, which sets state to `idle` directly and does **not** go through the 900ms auto-listen delay at all (that delay only exists inside the `onended` callback). A turn that fails on the audio side thus returns to `idle` faster and without any echo-decay buffer, then requires a manual click.

`onended` is also guarded against firing twice per turn via a per-turn `completeFired` flag (line 229, checked at line 292-296) — a fix for an observed double-fire bug, cause not fully diagnosed, just contained.

---

## 5. TTS Route — Current State

`voice_b64` is sent **unconditionally on every call** now (`app/api/tts/route.ts:112`, `voice_b64: voiceB64` with no conditional). There is **no `isWarm` logic currently** — a `warmPersonas` Set + conditional-omission optimization existed at one point but was deliberately removed (per project history) because RunPod workers can idle-restart independently of the Next.js process, desyncing the two caches and causing silent TTS failures from turn 3 onward. The only remaining optimization is server-side, inside `runpod-worker/handler.py`'s `_voice_tensor_cache` (in-memory dict keyed by `persona_id`, storing the converted WAV bytes) — this is invisible to the Next.js route and has no client-observable "warm/cold" signal.

**RunPod error handling / call-page recovery:**
- Network error or 600s timeout on the initial `fetch` → `502` with a message (route-level, `app/api/tts/route.ts:117-128`).
- Non-OK HTTP status from RunPod → `502`.
- `IN_QUEUE`/`IN_PROGRESS` → polls `/status/{jobId}` every 3s for up to 5 minutes; `FAILED`/`CANCELLED` → `502`; timeout → `504`.
- Malformed JSON body → `502`.
- Missing `audio_base64` in the final output → `502` ("empty response").
- On the call page, every one of these surfaces as `flushClause`'s fetch returning `null` for that clause (caught inside its own try/catch) — the page does not distinguish error types, it just treats any failed clause as "no audio for this clause" and, if all clauses fail, shows `"Voice failed — tap to try again"` and returns to `idle`. The user must manually retry (click the mic) — there is no automatic retry-with-different-payload or backoff.
- On the chat page (`app/chat/[id]/page.tsx`), a 422 (no voice reference) is surfaced distinctly via `ttsError`/`ttsFailed` + a `Retry` button per-message; other errors just say `"Playback failed"`.

---

## 6. Warmup Manager — Current State

- **Mount point**: `WarmupManagerProvider` wraps `{children}` inside `SessionProvider` in the root layout (`app/layout.tsx:50-52`) — a single instance for the entire app, one level below the session provider, above every route.
- **Interval**: `WARMUP_INTERVAL_MS = 50_000` (50s) in `hooks/useWarmupManager.ts:4`; `setInterval` pings `POST /api/warmup-runpod` on that cadence.
- **Gating**: the whole hook is a no-op unless `NEXT_PUBLIC_WARMUP_ENABLED === "true"` (checked at every `start`/`pause`/`resume`/mount-effect entry point).
- **Pause/resume**: `WarmupManagerProvider` watches `usePathname()` and calls `manager.pause()` whenever the route starts with `/call/` or `/chat/`, `manager.resume()` otherwise (`components/WarmupManagerProvider.tsx:18-28`).
- **Destroy**: one-way — `SignOutButton` calls `destroy()` before `signOut()`; once destroyed, `resume()` becomes permanently inert until a fresh mount (e.g., logging back in) creates a new hook instance.
- **UI**: it shows **nothing** to the user — no toast, no banner, no loading indicator tied to warmup pings. It's entirely invisible; the only visible artifact of "is the model warm" is indirectly the call page's own separate "Connecting…" pre-screen, which is driven by a *different* mechanism (a real greeting-TTS fetch on persona load, not this interval).
- **If a ping takes longer than 50s**: nothing coordinates this. `ping()` fires a bare `fetch(...).catch(() => {})` with no timeout, no abort, and no de-duplication against the next interval tick — if a ping is still in flight when the next 50s tick fires, a second concurrent ping fetch is issued regardless. Both are fire-and-forget; neither result is awaited or used by anything.
- **Downstream target**: `/api/warmup-runpod` itself has no timeout on its RunPod fetch either — a slow/hanging RunPod response there would leave that route's own request open indefinitely (bounded only by whatever platform-level function timeout applies, since no `maxDuration` is set on this route unlike `/api/tts`'s explicit 600s).

---

## 7. Known Broken Things

Since this session cannot run `npm run dev`/open a browser, the items below are what's derivable from the code itself (console.log/console.error/console.warn call sites and known-incomplete logic), not a live-captured console transcript:

- **Leftover debug styling still in `app/chat/[id]/page.tsx:493-494`**: the user-message bubble still carries `style={{border:'3px solid red', width:'100%'}}` and the inner bubble `style={{zIndex: 9999, position: 'relative'}}` — diagnostic styling from an earlier debugging round that was never removed. Every user chat bubble currently renders with a visible red border in production.
- **Heavy `console.log` instrumentation left in `app/call/[id]/page.tsx`**: `[submitTurn CALLED]` (with a stack trace), `[Turn START]`, `[TURN] submitting`, `[State → listening]` (with a stack trace), `[State → speaking]`, `[AudioQueue] onComplete fired...`, `[DG] is_final...`, `[DG] FINAL transcript...`, `[DG] ignoring final...`, `[DG] non-Results message...`, `[Accumulator]`/`[TURN] submitting from accumulator` — all still active, not gated behind a dev-only flag. Verbose but not itself broken; worth knowing before adding more.
- **`AudioQueue.onended` double-fire**: explicitly called out in code comments as an "observed" bug (two consecutive `onComplete fired` logs), worked around with a `completeFired` per-turn flag rather than root-caused.
- **Auto-resume-to-listening after speech is a recent, not-fully-battle-tested behavior change**: the 900ms post-audio auto-promotion to `"listening"` is new relative to the original click-to-toggle design; it changes the interaction model (mic can start capturing without another click) and its interaction with `awaitingFinalRef`/`sendAudioRef` has not been confirmed working end-to-end in a live browser session within this audit's scope.
- **`Metadata`/`UtteranceEnd` messages are requested but ignored**: the Deepgram WS URL asks for `utterance_end_ms=2000`, implying an intent to use `UtteranceEnd` events, but the handler discards all non-`Results` messages unconditionally — that signal is currently wasted.
- **No visible UI for warmup state**: if `RUNPOD_TTS_ENDPOINT_ID`/`RUNPOD_API_KEY` are misconfigured or the worker is scaled to 0, `useWarmupManager`'s pings fail silently (caught and swallowed) with zero user-facing indication — the only place cold-start pain becomes visible is the call page's own "Connecting…" screen from the greeting fetch.
- **Mute button and mic-error banner have no UI slot**: `isMuted`/`toggleMute`/`micError` state all still exist and function in `app/call/[id]/page.tsx`, but `WallpaperCall` (which replaced the old custom call UI) has no rendered element for either — a mic error currently has no visible surface to the user on the call page.
- **`/api/tts`'s known cache-desync class of bug**: even with the `isWarm` optimization removed from the Next.js side, the underlying architectural fact remains — `runpod-worker/handler.py`'s `_voice_tensor_cache` is per-worker-process state with no persistence guarantee across RunPod's own scaling/idle-timeout behavior, so any *future* re-introduction of a "skip voice_b64" optimization needs to solve this differently (e.g. a cache-hit acknowledgment from the worker) rather than a client-side-only assumption.

---

## 8. What Is Working

Based on the code as currently written (this audit did not execute the app, so "working" here means "the code path is structurally coherent and internally consistent," not "empirically verified in a live browser session in this audit"):

- **LLM fallback chain** (`app/api/chat/route.ts`): Groq → OpenAI (`gpt-4o-mini`) → hardcoded stub, cleanly layered with a shared SSE emission format (`callLLM`/`callGroqLLM`/`callOpenAILLM`), and a stub path that still emits well-formed emotion+content+DONE events matching the real providers' shape.
- **Emotion-tag extraction** from the LLM's raw text stream (`stripStrayLeadingChar`, tag-regex match) is defensive against split/glued tokens.
- **TTS request flow, happy path**: persona ownership check → voice ref fetch/strip → Chatterbox param resolution (persona override > emotion preset > default) → RunPod `runsync` → `IN_QUEUE`/`IN_PROGRESS` polling for cold starts → returns `audio_base64`/`sample_rate`. Structurally complete end-to-end.
- **`runpod-worker/handler.py`'s warmup-mode shortcut**: returns immediately with zero inference cost, checked before any other parsing — cheap and correctly ordered first in `handler()`.
- **`runpod-worker/handler.py`'s voice-tensor cache**: correctly writes cached bytes straight to a fresh temp file on a hit, and the existing per-job `finally` cleanup is untouched and applies uniformly regardless of hit/miss.
- **Chat page (`app/chat/[id]/page.tsx`) send flow**: optimistic user-message append before the fetch, clause-streamed TTS playback, client-side timeout independent of the server, SSE buffering that correctly holds incomplete trailing events across `reader.read()` chunks.
- **Warmup manager pause/resume/destroy lifecycle**: correctly scoped as a single shared instance via Context, correctly one-way on `destroy()`, correctly gated behind an env flag for local dev.
- **Deepgram auth workaround**: short-lived project API key via `Sec-WebSocket-Protocol`, avoiding the JWT-too-long-for-header problem — documented and consistent with how the WS is actually opened.

---

## 9. The 3 Highest Risk Areas

1. **The call page's state machine + `awaitingFinalRef`/`stateRef`/`ConvState` interplay** (`app/call/[id]/page.tsx`, roughly lines 163-415 and 680-746). This is the highest-risk area by far: it has already been rewritten multiple times in-session (adding `awaitingFinalRef`, the 900ms auto-listen delay, the `completeFired` guard, the empty-transcript double-guard) to fix regressions each prior change introduced. The current design relies on the precise interaction of three independent pieces of mutable state (`ConvState`, `awaitingFinalRef`, `sendAudioRef`) plus two timers (900ms echo-delay, 800ms accumulator-fallback) plus a monotonic `turnIdRef` for staleness checks. Any future change that touches one of these without tracing all five is very likely to silently break turn completion again (as already happened twice this session) — because the failure mode is not a crash, it's a silently-discarded transcript, which is hard to notice without deliberately-added logging.
2. **`AudioQueue.onended` registration and firing** (`lib/audio.ts`'s `createAudioQueue`, and its two call sites in `app/call/[id]/page.tsx`). `onended` is a single overwritable callback slot (not a subscriber list), only ever registered from inside the "first clause audio" branch — meaning if a turn produces zero playable audio, `onended` for that turn never registers and never fires, silently skipping the 900ms auto-listen path entirely. The double-fire bug here was patched with a flag but never root-caused; the actual mechanism producing the duplicate is still unknown, which means the same class of bug could resurface elsewhere in the queue.
3. **The Deepgram WS message contract vs. what's actually handled** (`connectDeepgram`, `app/call/[id]/page.tsx:438-503`). `utterance_end_ms=2000` is requested but `UtteranceEnd` messages are discarded unconditionally in the `msg.type !== "Results"` branch — meaning a second, more patient finalization signal Deepgram is already sending is currently inert. Anyone asked to "make it use UtteranceEnd" or "make it more responsive" without reading this section first will likely duplicate submission logic or reintroduce the exact echo-loop bug that `awaitingFinalRef` was built to avoid, since `UtteranceEnd` would need the same `awaitingFinalRef`-style gating as `is_final` does, not the coarse `ConvState` check that was already proven insufficient once.

---

## 10. What Claude Needs To Know Before Giving Fix Prompts

- **`submitTurn` sets state to `"thinking"` via the stop-click, before Deepgram's final for that utterance ever arrives.** Any gate that checks `stateRef.current === "listening"` alone will reject the legitimate final. The current fix is `awaitingFinalRef`, a separate boolean tracking "we're expecting exactly one more final for the utterance we just stopped" — independent of `ConvState`. Any new gate on `submitTurn`/the DG handler must account for this or it will silently break turn completion again (this has already happened once in this project's history).
- **`AudioQueue.onended` is a single mutable callback slot, not an event-subscriber list**, and it is only ever *registered* inside the "first clause has audio" branch of `flushClause`. If a turn's TTS fails for every clause, `onended` is never registered for that turn and therefore never fires — the 900ms auto-listen delay (which lives entirely inside that callback) simply does not run in that case; the turn instead resolves to `idle` immediately via a separate epilogue path with no echo-decay buffer.
- **The 900ms "echo delay" auto-promotion to `"listening"`, and the click-to-stop flow, are two independent paths that can both set `"listening"`.** A fix that assumes only one of them exists (e.g., "just add a click handler that sets listening") will miss the other and can reintroduce a race.
- **`sendAudioRef` (whether mic bytes are actually forwarded to Deepgram) is a separate boolean from `ConvState`.** Setting `state` to `"listening"` does not, by itself, make the mic send anything — every place that transitions into `"listening"` must also explicitly set `sendAudioRef.current = true` (and confirm `micStreamRef.current` exists), or the state will say "listening" while capturing nothing.
- **There is no `isWarm`/voice-caching optimization on the Next.js side anymore, by deliberate removal.** `voice_b64` is sent on every single `/api/tts` call. The only caching left is `runpod-worker/handler.py`'s in-memory `_voice_tensor_cache`, which is per-RunPod-worker-process and has no visibility into whether the Next.js side thinks a persona is "warm." Do not reintroduce a Next.js-side skip-the-payload optimization without solving the cross-process cache-desync problem (RunPod can restart a worker independently of the Next.js server process at any time) — this exact optimization was tried and reverted once already.
- **`turnIdRef` is the sole staleness guard for all async work inside a turn** (SSE reads, TTS clause fetches, the `ttsChain` promise chain, the `onended` callback, the 900ms/800ms timers). Any new async step added to the turn pipeline must check `turnIdRef.current === myTurnId` before touching shared state, or a superseded turn's late-arriving work will corrupt the current turn's state.
- **The call page and the chat page (`app/chat/[id]/page.tsx`) do not share any state, hooks, or pipeline code** beyond `usePersona`, `useFillerAudio`, and the `lib/audio.ts` helpers — they each have their own independent `sendMessage`/`submitTurn`, their own `AudioQueue` instance, and their own SSE-parsing loop. A fix made in one does not apply to the other; they must be changed in parallel deliberately, not assumed to share a fix.
- **`/api/chat` falls back from Groq to OpenAI on *any* Groq failure**, not a narrow allowlist of error types — this is intentional (a stricter allowlist was considered and rejected) to avoid silently not-falling-back on an unanticipated failure shape. Do not "tighten" this to only catch specific errors without knowing this was already decided against.
- **`useWarmupManager`'s ping has no timeout, no abort, and no in-flight de-duplication.** If asked to "make warmup pings more reliable" or "avoid overlapping pings," know that the current code has zero protection against overlap today — any fix needs to add this from scratch, not adjust existing logic.
- **`app/chat/[id]/page.tsx` still contains leftover diagnostic inline styles** (red border + `zIndex: 9999` on the user bubble) from a prior debugging session — these were never cleaned up. Do not assume they're intentional styling if asked to "fix the chat bubble appearance."
