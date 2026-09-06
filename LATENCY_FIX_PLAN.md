# Lyra Voice Latency Fix Plan

Status: **planning only — no code changes applied**. Every section below was written after reading the actual current files listed; corrections to the original brief's assumptions are called out explicitly where the real code (or Deepgram's real API) didn't match what was assumed, the same way every other change this session has been verified against real code rather than transcribed from a template.

Files read to produce this plan:
- `lyra-mobile/app/(app)/call/[id].tsx` (mobile call screen)
- `persona-app/app/call/[id]/page.tsx` (web call screen — **note the real path has no `(app)` route group**; `persona-app/app/(app)/call/[id]/page.tsx` named in the brief does not exist)
- `persona-app/app/api/chat/route.ts`
- `lyra-mobile/package.json` (to confirm `expo-av` vs `expo-audio`)
- Deepgram's live docs for Flux (`/docs/flux/*`), since the event names and params are a concrete, falsifiable claim worth checking before this plan tells anyone to build against them

---

## Section 1: Deepgram Flux Migration

### Correction to the brief before the diff

Flux is real — `flux-general-en`, `EagerEndOfTurn`, `TurnResumed`, and `EndOfTurn` are all confirmed in Deepgram's current docs. But **Flux does not use `endpointing` or `utterance_end_ms` at all** — those are Nova-series concepts tied to the old VAD+Results architecture (`SpeechStarted`/`UtteranceEnd`) both call screens currently use. Flux replaces that entire mechanism with three of its own params:

| Param | Range | Default | Purpose |
|---|---|---|---|
| `eot_threshold` | 0.5–0.9 | 0.7 | Confidence required to fire `EndOfTurn` |
| `eager_eot_threshold` | 0.3–0.9 | unset | Setting this at all is what *enables* `EagerEndOfTurn`/`TurnResumed`. Lower = earlier trigger, more false starts |
| `eot_timeout_ms` | — | — | Hard timeout: turn ends after this many ms regardless of confidence |

There is no Flux equivalent of "endpointing=500 as fallback" — `eot_timeout_ms` is the closest concept (a hard backstop), not a tunable in the same units. Also: **the endpoint changes from `/v1/listen` to `/v2/listen`**, confirmed in Deepgram's quickstart. Deepgram's own docs do not publish an exact JSON schema for the three new event types beyond their `type` field — implementation should confirm the full payload shape against Deepgram's reference during actual coding, not assume it mirrors `SpeechStarted`/`UtteranceEnd` exactly.

Sources: [Getting Started with Flux](https://developers.deepgram.com/docs/flux/quickstart), [End-of-Turn Detection Parameters](https://developers.deepgram.com/docs/flux/configuration), [Optimize Voice Agent Latency with Eager End of Turn](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot), [Turn-based Audio (Flux)](https://developers.deepgram.com/reference/speech-to-text/listen-flux)

### 1a. WebSocket URL diff

**`lyra-mobile/app/(app)/call/[id].tsx`** (line 179 today):

```diff
-      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&endpointing=300&vad_events=true&utterance_end_ms=1000&smart_format=true&interim_results=true`;
+      const wsUrl = `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.7&eager_eot_threshold=0.5&eot_timeout_ms=3000&smart_format=true`;
```

Notes: this file is currently on `model=nova-2` (not `nova-3`, unlike the web page — an existing inconsistency between the two clients, unrelated to this migration but worth knowing). Dropped `vad_events`/`interim_results`/`utterance_end_ms` — none apply to Flux's turn-detection model. `eager_eot_threshold=0.5` is a starting point (mid-range of Deepgram's 0.3–0.9), not a value verified against this app's actual audio characteristics — needs real tuning once implemented, the same way `endpointing` went through multiple revisions (1500 → 300) in this codebase already.

**`persona-app/app/call/[id]/page.tsx`** — `buildDeepgramWsUrl()`, lines 38–51 today:

```diff
 function buildDeepgramWsUrl(personaName?: string | null, userName?: string | null): string {
   const params = new URLSearchParams({
-    model: "nova-3",
+    model: "flux-general-en",
     interim_results: "true",
     smart_format: "true",
-    endpointing: "300",
-    utterance_end_ms: "1000",
-    vad_events: "true",
+    eot_threshold: "0.7",
+    eager_eot_threshold: "0.5",
+    eot_timeout_ms: "3000",
   });
   params.append("keyterm", "Lyra");
   if (personaName) params.append("keyterm", personaName);
   if (userName) params.append("keyterm", userName);
-  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
+  return `wss://api.deepgram.com/v2/listen?${params.toString()}`;
 }
```

`keyterm` boosting (Nova-3's "Keyterm Prompting" feature) is a Nova-3-specific capability — **verify it's still supported on Flux before assuming this carries over unchanged**; if not, the persona/user name boosting added a couple of sessions ago would need to be dropped for this URL. `interim_results` was kept since transcript display during "listening" likely still wants interim text, but confirm Flux still emits `Results`-style interim messages the same way, since its docs frame everything around the turn-state-machine, not classic interim/final Results.

### 1b. New event handler

Both files currently branch on `msg.type === 'SpeechStarted' | 'UtteranceEnd' | 'Results'`. Replacing the turn-boundary logic (barge-in via `SpeechStarted` stays conceptually separate — see "what stays the same" below):

**`lyra-mobile/app/(app)/call/[id].tsx`** — replacing the `else if (msg.type === 'UtteranceEnd')` branch (lines 217–249 today):

```diff
+  const eagerFetchRef = useRef<{ turnId: number; controller: AbortController } | null>(null);
+
   ws.onmessage = (event: any) => {
     ...
-    if (msg.type === 'Results') {
-      const transcript = msg.channel?.alternatives?.[0]?.transcript;
-      if (transcript) interimTranscriptRef.current = transcript;
-      if (msg.is_final && transcript) {
-        transcriptBufferRef.current += ' ' + transcript.trim();
-      }
-    } else if (msg.type === 'UtteranceEnd') {
-      const buffered = transcriptBufferRef.current.trim();
-      ...
-      if (buffered && stateRef.current === 'listening') {
-        transcriptBufferRef.current = '';
-        submitTurn(buffered);
-      }
-    } else if (msg.type === 'SpeechStarted') {
+    if (msg.type === 'EagerEndOfTurn') {
+      // Fire /api/chat immediately on a provisional transcript — start the
+      // LLM call before the user has definitely finished. transcript field
+      // name/shape not confirmed against Deepgram's reference; verify
+      // during implementation.
+      const provisional = msg.transcript ?? transcriptBufferRef.current.trim();
+      if (provisional) {
+        const myTurnId = ++turnIdRef.current;
+        eagerFetchRef.current = { turnId: myTurnId, controller: new AbortController() };
+        submitTurn(provisional, { eager: true, turnId: myTurnId, controller: eagerFetchRef.current.controller });
+      }
+    } else if (msg.type === 'TurnResumed') {
+      // User kept talking — the eager call was premature. Cancel it; the
+      // (still-listening) mic keeps accumulating for the next EndOfTurn.
+      eagerFetchRef.current?.controller.abort();
+      eagerFetchRef.current = null;
+    } else if (msg.type === 'EndOfTurn') {
+      const buffered = transcriptBufferRef.current.trim();
+      transcriptBufferRef.current = '';
+      if (eagerFetchRef.current) {
+        // Eager call already in flight and never cancelled by TurnResumed —
+        // let it run to completion instead of firing a duplicate request.
+        eagerFetchRef.current = null;
+        return;
+      }
+      if (buffered && stateRef.current === 'listening') {
+        submitTurn(buffered);
+      }
+    } else if (msg.type === 'SpeechStarted') {
       ...
```

`submitTurn` needs a second optional parameter so an eager call reuses the caller-supplied `turnId`/`AbortController` instead of minting its own (today it always does `const myTurnId = ++turnIdRef.current;` internally — that has to change to accept an externally-assigned one for this to work, since the eager fetch's `turnId` is decided at `EagerEndOfTurn` time, not inside `submitTurn`). This is a real signature change to `submitTurn`, not just a call-site tweak — flagging it rather than hand-waving it, since `submitTurn` is used elsewhere (the barge-in/normal path) and both call shapes need to keep working.

**`persona-app/app/call/[id]/page.tsx`** — same shape change, applied to the `ws.onmessage` handler inside `connectDeepgram()` (lines 569–624 today) and `submitTurn()` (lines 320+). Not repeated verbatim here since it's structurally identical to the mobile diff above — same three-branch replacement, same `submitTurn` signature question.

### 1c. What stays the same

- **Barge-in** (`SpeechStarted` → `handleBargein()`/`triggerBargeIn()`, the 600ms `ttsStartedAtRef` guard) — Flux's docs don't describe removing `SpeechStarted`-equivalent interruption detection; if Flux doesn't emit `SpeechStarted` at all, this needs its own verification pass, but nothing in this plan changes the 600ms guard's logic.
- `emotionHistoryRef`, Zone 2.5 — untouched, this is a `/api/chat` payload concern, orthogonal to STT.
- `keepAliveIntervalRef`/`KEEPALIVE_INTERVAL_MS` — Flux is still a WebSocket; whether it needs the same 8s KeepAlive cadence isn't confirmed either way in what I read, so left as-is.

### 1d. Risk

Per Deepgram's own docs: **eager end-of-turn firing means 50–70% more LLM calls hit DeepSeek**, since every `EagerEndOfTurn` that gets cancelled by a following `TurnResumed` already cost a real DeepSeek request before the cancellation signal arrived (aborting the client-side fetch doesn't retroactively un-charge the DeepSeek call in flight). At `eager_eot_threshold=0.5` (this plan's starting value), expect meaningfully more DeepSeek spend for the ~150–250ms latency Deepgram's docs cite as the typical eager-vs-final gap. This is a direct cost/latency tradeoff — not a free win — and should be measured against actual DeepSeek billing, not assumed acceptable.

---

## Section 2: Pre-warm on Call Mount

### 2a. Deepgram pre-connect

Today, both call screens gate the WebSocket connection behind mic-permission (`AudioModule.requestRecordingPermissionsAsync()` on mobile, `navigator.mediaDevices.getUserMedia()` on web) inside the same effect that opens the socket — permission and connection are sequential, not overlapped.

**`lyra-mobile/app/(app)/call/[id].tsx`** — the SETUP effect (lines 131–265):

```diff
   useEffect(() => {
     let cancelled = false;
+
+    // Pre-connect: open the Deepgram WS immediately, before mic permission
+    // is even requested. No audio is sent until sendAudioRef flips true
+    // (still gated on mic permission + stream start, unchanged below) —
+    // this only removes the token-fetch + WS-handshake latency from the
+    // critical path, it doesn't send audio without permission.
+    let dgKeepAlive: ReturnType<typeof setInterval> | null = null;

     (async () => {
       try {
         const res = await apiFetch('/api/personas');
         ...
       } catch (e: any) { ... }

-      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
-      if (cancelled) return;
-      if (!granted) { ... }
-
-      let dgKey: string;
-      try {
-        const tokenRes = await apiFetch('/api/deepgram-token');
-        ...
-      } catch (e: any) { ... }
-      if (cancelled) return;
-
-      const wsUrl = `wss://api.deepgram.com/v2/listen?...`;
-      const ws = new WebSocket(wsUrl, ['token', dgKey]);
-      wsRef.current = ws;
+      // Kick off token fetch + WS connect and mic permission in parallel —
+      // today they're sequential for no reason (neither depends on the
+      // other's result).
+      const dgConnectPromise = (async () => {
+        let dgKey: string;
+        try {
+          const tokenRes = await apiFetch('/api/deepgram-token');
+          const tokenData = await tokenRes.json();
+          const resolvedKey = tokenData.key ?? tokenData.token ?? tokenData.apiKey ?? tokenData.result?.key;
+          if (!resolvedKey) throw new Error('No Deepgram key in response');
+          dgKey = resolvedKey;
+        } catch (e: any) {
+          if (e?.message !== 'Session expired') {
+            console.error('[call] failed to get deepgram token:', e?.message ?? e);
+          }
+          return null;
+        }
+        if (cancelled) return null;
+
+        const wsUrl = `wss://api.deepgram.com/v2/listen?...`; // per Section 1
+        const ws = new WebSocket(wsUrl, ['token', dgKey]);
+        wsRef.current = ws;
+        // Attach onmessage/onerror/onclose exactly as today (unchanged) —
+        // omitted here for brevity, not a real behavior change.
+        return ws;
+      })();
+
+      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
+      if (cancelled) return;
+      if (!granted) {
+        Alert.alert('Microphone access needed', 'Enable microphone access in Settings to make calls.');
+        router.back();
+        return;
+      }
+
+      const ws = await dgConnectPromise;
+      if (!ws || cancelled) {
+        if (ws) return; // dgConnectPromise already logged/alerted internally on failure
+        Alert.alert('Connection failed', 'Could not get audio token. Try again.');
+        router.back();
+        return;
+      }

       ws.onopen = async () => {
         if (cancelled) return;
         try {
           await stream.start();
           updateState('listening');
           timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
         } catch (e: any) { ... }
       };
       // ws.onmessage / onerror / onclose unchanged
+
+      // Keep-alive ping every 10s while socket may be open with no audio
+      // flowing yet (before mic permission resolves, or while muted).
+      dgKeepAlive = setInterval(() => {
+        if (wsRef.current?.readyState === WebSocket.OPEN) {
+          wsRef.current.send(JSON.stringify({ type: 'KeepAlive' }));
+        }
+      }, 10_000);
     })();

-    return () => { cancelled = true; };
+    return () => {
+      cancelled = true;
+      if (dgKeepAlive) clearInterval(dgKeepAlive);
+    };
   }, []);
```

This is a real restructure of the SETUP effect's control flow (mic permission and WS connect now race instead of chain), not a one-line tweak — worth reviewing carefully since `cancelled` guards need to correctly cover both branches of the race, and the existing `ws.onopen` already calls `ensureMicReady()` which itself gates on permission — there's likely now a redundant permission-check path between this new code and `ensureMicReady()` that needs reconciling during actual implementation, not just this diff.

The mobile file already has its own separate `KEEPALIVE_INTERVAL_MS = 8_000` constant used differently (persona-app's version, not lyra-mobile's — lyra-mobile currently has **no existing KeepAlive interval at all**, only persona-app's web page does, at 8s not 10s). The `dgKeepAlive` above is genuinely new for mobile; on web, the existing 8s interval (`KEEPALIVE_INTERVAL_MS`, `keepAliveIntervalRef`) already does this and doesn't need duplicating — just confirm it still fires correctly once the WS opens earlier in the lifecycle.

**`persona-app/app/call/[id]/page.tsx`**: same shape of change — race `navigator.mediaDevices.getUserMedia()` against `connectDeepgram()`'s token-fetch-then-WS-open instead of chaining `ensureMicReady()` after `ws.onopen`. Not re-diffed line-by-line here; same restructuring principle as mobile.

### 2b. Cartesia pre-warm — already real, not a health check

Checked both files: **this already exists and already hits the real TTS endpoint**, not a lightweight ping.

- Mobile: `warmupCartesia()` ([id].tsx:75-84) — `POST /api/tts` with `{ personaId, text: 'hi' }`, fired from a dedicated `useEffect` on mount.
- Web: the greeting-warmup `useEffect` (page.tsx:731-767) — `POST /api/tts` with `{ personaId, text: "Hey, good to hear from you.", emotion: "happy" }`, and the resulting audio is cached (`greetingAudioRef`) and actually played as the call's opening line, not discarded.

Both are genuine, full-cost TTS generations (not `HEAD`/health-check requests), so Cartesia's HTTP connection and any per-persona voice-clone warm path are both exercised already. **No code change needed for this item** — flagging it as already done rather than manufacturing a diff.

### 2c. LLM pre-warm

`persona-app/app/api/chat/route.ts` has no warmup path today — every request runs the full pipeline (auth → persona lookup → user lookup → RAG → DeepSeek). Adding a guard:

```diff
 export async function POST(req: NextRequest) {
   console.log(`[CHAT] request received at ${Date.now()}`);
   const session = await auth();
   if (!session?.user) {
     return new Response("Unauthorized", { status: 401 });
   }

   const { personaId, message, history = [], emotionHistory } = await req.json();

   if (!personaId || !message) {
     return new Response("Missing personaId or message", { status: 400 });
   }
+
+  // Warmup ping — exercises auth + the persona ownership lookup (warms the
+  // Postgres/Neon connection pool, the actual "cold start" cost on a
+  // serverless function) without spending a DeepSeek call. Still requires
+  // a real session and a real personaId the caller owns, same as a normal
+  // request — not an unauthenticated backdoor into this route.
+  if (message === "__warmup__") {
+    const [warmupPersona] = await db
+      .select({ id: personas.id })
+      .from(personas)
+      .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
+      .limit(1);
+    if (!warmupPersona) {
+      return new Response("Persona not found", { status: 404 });
+    }
+    return sseStream([
+      `data: ${JSON.stringify({ content: "" })}\n\n`,
+      "data: [DONE]\n\n",
+    ]);
+  }

   const safeEmotionHistory = sanitizeEmotionHistory(emotionHistory);
   ...
```

Call sites (new mount-time effects, both platforms):

```typescript
// lyra-mobile/app/(app)/call/[id].tsx and persona-app/app/call/[id]/page.tsx
useEffect(() => {
  fetch(`${API_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // web only — mobile's streamingFetch call already omits this today too for consistency, confirm which is actually needed
    body: JSON.stringify({ personaId, message: '__warmup__', history: [], emotionHistory: [] }),
  }).catch(() => {});
}, []);
```

This does **not** warm DeepSeek/Groq's connection at all — by design, since the whole point is avoiding a real LLM call. If DeepSeek's own per-request cold latency (not this app's serverless function) is part of the 5-10s problem, this specific fix doesn't touch that; only Next.js's own function cold-start is addressed here.

---

## Section 3: Local Filler Audio

### Correction to the brief

The brief says "expo-av (already installed)" — checked `lyra-mobile/package.json`: **`expo-av` is not a dependency at all.** Only `expo-audio: ~57.0.3` is installed, and it's what the call screen already uses (`useAudioPlayer`, `useAudioStream` from `expo-audio`, imported at the top of `[id].tsx`). The filler player needs to use `expo-audio`'s API, consistent with the rest of the file, not introduce a second, older audio library alongside it.

### 3a. Asset files

Create `lyra-mobile/assets/fillers/` with `hmm.mp3`, `letmethink.mp3`, `yeah.mp3`, `interesting.mp3`, `gotit.mp3`. **These audio files themselves have to be recorded/sourced by you** — I can write the code that loads and plays them, but I can't generate actual audio content. Recommend recording these in the cloned persona's own voice (or a neutral one, if fillers are meant to be voice-agnostic) so they don't sound jarringly different from the real TTS output that follows them.

### 3b. Filler timer + playback

**`lyra-mobile/app/(app)/call/[id].tsx`** — new imports and a filler player, mirroring the existing `player`/`useAudioPlayer(null)` pattern already in this file:

```typescript
import { useAudioPlayer, useAudioStream, AudioModule } from 'expo-audio';

const FILLER_CLIPS = [
  require('../../../assets/fillers/hmm.mp3'),
  require('../../../assets/fillers/letmethink.mp3'),
  require('../../../assets/fillers/yeah.mp3'),
  require('../../../assets/fillers/interesting.mp3'),
  require('../../../assets/fillers/gotit.mp3'),
];
const FILLER_DELAY_MS = 800;
```

Inside `CallScreen()`, alongside the existing `player`:

```typescript
const fillerPlayer = useAudioPlayer(null);
const fillerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const fillerActiveRef = useRef(false);
```

In `submitTurn()`, right after `updateState('thinking')` (or at whichever event now starts the turn per Section 1's `EagerEndOfTurn`/`EndOfTurn` handling):

```diff
     updateState('thinking');
     historyRef.current.push({ role: 'user', content: transcript });

     abortRef.current = new AbortController();
+
+    // Start the filler countdown now — if no real content token arrives
+    // within FILLER_DELAY_MS, play a local clip instead of relying on
+    // DeepSeek generating disfluencies (removed from Zone 2, see 3c below).
+    fillerTimerRef.current = setTimeout(() => {
+      const clip = FILLER_CLIPS[Math.floor(Math.random() * FILLER_CLIPS.length)];
+      fillerPlayer.replace(clip);
+      fillerPlayer.play();
+      fillerActiveRef.current = true;
+    }, FILLER_DELAY_MS);
```

Where `evt.content !== undefined` is first handled (the existing `if (!firstTokenSeen) firstTokenSeen = true;` branch):

```diff
         } else if (evt.content !== undefined) {
+          if (fillerTimerRef.current) {
+            clearTimeout(fillerTimerRef.current);
+            fillerTimerRef.current = null;
+          }
+          if (fillerActiveRef.current) {
+            fillerPlayer.pause();
+            fillerActiveRef.current = false;
+          }
           if (!firstTokenSeen) firstTokenSeen = true;
           fullResponse += evt.content;
           ...
```

And in the abort/cleanup paths (`triggerBargeIn`/error catch/`handleEndCall`), clear `fillerTimerRef` and stop `fillerPlayer` the same way `stopFiller()` already does for the *existing* live-TTS-based filler system on the web page — mobile doesn't have an equivalent `stopFiller()` helper today, so one should be added rather than repeating this cleanup inline in four places.

Note the SSE event name: the brief says "the first SSE `type:\"text\"` chunk" — **the real event shape has no `type` field for content at all**; content chunks are `{ content: "..." }` with no `type` key (only `emotion` and `error` events carry a `type` field — confirmed in `app/api/chat/route.ts`'s `controller.enqueue` calls and the client's own `evt.content !== undefined` check). The diff above uses the actual shape, not `type:"text"`.

### 3c. Remove disfluency instruction from Zone 2

**`persona-app/app/api/chat/route.ts`**, inside `buildZone2()`:

```diff
 You speak the way people actually talk, not the way people write.

 LENGTH — 1–2 sentences per turn, almost always. Never a list.
 If something needs explaining, spread it across short turns rather
 than one long answer.

-DISFLUENCY — include 2–4 natural speech markers per turn.
-Never zero (that reads robotic), never more than 4 (that reads scripted),
-never two back to back:
-  "um" / "uh"          — before something that takes real thought
-  "you know" / "I mean" — when checking the other person is following
-  self-correction       — "I- I think—", "wait, actually—"
-If a reply comes out as one clean polished sentence with no texture,
-it slipped out of voice. It needs a rewrite before sending.
-
 TONE — match ${userName}'s energy level. Crisp input → crisp reply.
 Long emotional input → slower, warmer reply.
 Laugh or exclaim roughly 1 turn in every 4–5, not every turn.
```

Worth knowing: this instruction was added deliberately in an earlier session specifically to make DeepSeek's *text* sound more human (disfluencies like "um"/"you know" as a realism layer for the conversation transcript, independent of TTS). Removing it trades that realism-in-text goal for TTS latency — every "um" and self-correction Cartesia currently has to synthesize does cost real generation + network time per clause, so the tradeoff is real, but it's not solely a leftover/mistake being cleaned up; it's an intentional design goal from a prior task being traded away here. Confirm that trade is wanted before removing it, since undoing it later means re-deriving wording that took a few iterations to land on originally (see the EMOTION EXPRESSION section right below it in the same file, which went through multiple rewrites this session).

---

## Section 4: Parallel Execution on `/api/chat`

### What the code actually does — and why "RAG + LLM call in parallel" isn't the right framing

Read `app/api/chat/route.ts` closely: RAG and the LLM call **cannot** run in parallel as literally stated, because Zone 3 (`formatMemoriesAsRecollections`) bakes the retrieved memories directly into the system prompt string, which is then embedded as the first message in the array sent to DeepSeek. The LLM call structurally cannot start until `memories` is known — there's a real data dependency, not just an accidental sequential ordering.

What **is** genuinely sequential and independent — the real win here — is two separate, unrelated awaited calls that don't need each other's results at all:

```typescript
// current (lines ~527-558), sequential:
const [persona] = await db.select().from(personas).where(...).limit(1);   // must come first — gates 404
if (!persona) return new Response("Persona not found", { status: 404 });

persistMessage({...}).catch(...);   // already fire-and-forget, not on critical path

const [user] = await db.select({ displayName, profileBio }).from(users).where(...).limit(1);  // ← independent
const memories = process.env.PINECONE_API_KEY ? await queryMemories(personaId, message) : [];  // ← independent
```

`user` (a Postgres/Neon lookup) and `memories` (a Pinecone integrated-inference search) don't depend on each other — only `buildSystemPrompt()` afterward needs both. Refactor:

```diff
-  const [user] = await db
-    .select({ displayName: users.displayName, profileBio: users.profileBio })
-    .from(users)
-    .where(eq(users.id, session.user.id))
-    .limit(1);
-
-  console.log(`[RAG] querying for personaId: ${personaId}, message: "${message?.slice(0, 50)}"`);
-
-  // Pinecone integrated inference embeds `message` server-side — no separate
-  // embedding call. Degrades to [] if the persona has no memories yet.
-  const memories = process.env.PINECONE_API_KEY ? await queryMemories(personaId, message) : [];
-
-  console.log('[RAG] memories fetched:', memories?.length ?? 0,
-              memories?.map(m => m.substring(0, 50)));
+  console.log(`[RAG] querying for personaId: ${personaId}, message: "${message?.slice(0, 50)}"`);
+
+  // user lookup and RAG query are independent of each other — only
+  // buildSystemPrompt() below needs both. Was sequential for no reason.
+  const [[user], memories] = await Promise.all([
+    db
+      .select({ displayName: users.displayName, profileBio: users.profileBio })
+      .from(users)
+      .where(eq(users.id, session.user.id))
+      .limit(1),
+    process.env.PINECONE_API_KEY ? queryMemories(personaId, message) : Promise.resolve([]),
+  ]);
+
+  console.log('[RAG] memories fetched:', memories?.length ?? 0,
+              memories?.map(m => m.substring(0, 50)));
```

### Timing estimate

Not a benchmarked number — an estimate based on typical latencies for each call type:

| | Sequential (today) | Parallel (`Promise.all`) |
|---|---|---|
| User lookup (Neon Postgres, indexed single-row select) | ~10–50ms (more if the compute scaled to zero) | overlapped |
| RAG query (Pinecone integrated-inference search) | ~50–150ms | overlapped |
| **Total added to TTFT** | ~60–200ms (sum) | ~50–150ms (max of the two) |

Estimated saving: roughly the smaller of the two calls' duration, **~10–100ms** in practice — likely toward the low end of the brief's "50-200ms" estimate, since Pinecone is usually the slower of the two and dominates the parallel case too. This app already logs `[LLM] TTFT` — the real before/after numbers should be pulled from that log rather than trusted on estimate alone.

### Race condition risk

None introduced. Both calls are read-only with no shared mutable state between them. The only behavioral difference: today, if the `user` select throws, it throws immediately and skips the RAG query entirely (never spending a Pinecone call); under `Promise.all`, both are already in flight by the time either can fail, so a `user`-select failure means a Pinecone query still gets fired (and its result discarded) before the whole request fails. Not a correctness bug — `queryMemories` already can't throw (verified: `searchTextIndex` catches internally and returns `[]`) — just a very minor wasted-Pinecone-call-on-error-path cost, not worth guarding against separately.

---

## Section 5: Priority Order + Effort Matrix

| Fix | Estimated latency saved | Implementation effort | Risk |
|---|---|---|---|
| Parallel RAG + user lookup | ~10–100ms | Low | None (read-only, independent calls) |
| Pre-warm on mount (Deepgram race, LLM ping) | 300–800ms on cold start only (no effect on warm calls) | Low–Medium (Deepgram pre-connect requires restructuring the SETUP effect's control flow, not a one-liner) | Deepgram: one extra WS opened per call screen mount, billed the same as any connection; LLM warmup: negligible extra Postgres load |
| Local filler audio | 0ms saved on the real pipeline, but removes the perceived dead-air gap before first real audio | Low code, but blocked on **real audio assets you have to produce** | `expo-av` assumption was wrong — must build on `expo-audio`; needs testing that filler cancellation never overlaps real TTS audio |
| Remove Zone 2 disfluency instruction | Some amount of Cartesia synthesis + DeepSeek generation time per clause (not independently measured) | Low (a text deletion) | Trades away an intentional realism feature from an earlier session — confirm that's actually wanted, not just latency-motivated |
| Deepgram Flux migration | 150–250ms (Deepgram's own cited figure for eager vs. final EOT) | **High** — new WS endpoint, entirely different param model, `submitTurn` signature change to support externally-assigned turnIds, and both call screens need the change independently | **50–70% more LLM calls hit DeepSeek** (Deepgram's own documented figure) — a real, ongoing cost increase, not a one-time risk |

Suggested order, given the table above: parallel RAG+user lookup first (trivial, zero risk, do it regardless of anything else in this plan) → pre-warm on mount → local filler audio (once assets exist) → Zone 2 disfluency removal (pending confirmation it's wanted) → Flux migration last, since it's the highest effort, the least latency payoff per the numbers Deepgram itself publishes, and the only item with an ongoing cost tradeoff rather than a one-time implementation cost.

---

## Section 6: What NOT to Change

- DeepSeek stays primary (`callLLM` tries `callDeepSeekLLM` first, Groq only as fallback) — unaffected by anything in this plan.
- `MIN_CLAUSE_WORDS` stays at `4` in `persona-app/lib/audio.ts` — not touched by any section here (mobile's own clause logic, `shouldFlushClause`'s `< 10` char check and `MAX_CLAUSE_CHARS = 200`, is a separate, already-divergent implementation in `lyra-mobile/app/(app)/call/[id].tsx` — worth knowing the two platforms don't actually share this constant today, if that wasn't already clear from prior sessions).
- The 600ms barge-in guard (`ttsStartedAtRef`, `handleBargein`) — untouched; Section 1 explicitly calls out that Flux's barge-in equivalent (if `SpeechStarted` doesn't exist on Flux) is a separate open question, not something silently changed here.
- `emotionHistoryRef` and Zone 2.5 (`buildZone2_5`, the mood-trend/repeat-avoidance logic) — untouched by every section above; Section 4's `Promise.all` refactor doesn't touch `emotionHistory` handling at all.
