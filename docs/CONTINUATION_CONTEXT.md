# Persona App — Continuation Context
*Paste this whole file into a new Claude chat to resume work. ~2 min read.*

## 1. What this is

**Persona** is a voice-cloning digital-twin web app (Next.js 14 App Router,
TypeScript, Postgres/Drizzle on Neon). A user creates a consenting persona
(voice clone + optional 3D avatar + personality), and can then text-chat or
live-voice-call it. LLM replies via **Groq** (`llama-3.1-8b-instant`), TTS via
a custom **Chatterbox** voice-cloning worker on **RunPod Serverless**, STT via
**Deepgram** nova-3 (browser WebSocket), knowledge/memory retrieval via
**Pinecone** integrated inference, avatar lip-sync via **TalkingHead.js**
(CDN-loaded, not npm).

## 2. Phase Status

| Phase | Status |
|---|---|
| 1 Scaffold | ✅ Done |
| 2 Persona Creator (6 tabs) | ✅ Done |
| 3 STT + LLM + Text Chat | ✅ Done |
| 3.5 Timeout + Offline dev mode | ✅ Done |
| 4 TTS Voice Pipeline | ✅ Done |
| 4.5 Groq migration *(ad hoc, not a planned phase)* | ⚠️ Partial — only `/api/chat`, not `/api/memory/commit` or `/api/personas/generate-card` |
| 5 Live Call Page | ✅ Done |
| 6 Avatar + Lip-sync | 🚧 In progress — avatar hardcoded to a CDN test model, see bug #5 |
| 7 Memory, Polish, Deletion | ⛔ Not started |

## 3. Active Bugs (symptom → file:line → fix)

| # | Symptom | File:Line | Fix |
|---|---|---|---|
| 1 | Memory extraction after calls always returns `{stored:0, stub:true}` | `app/api/memory/commit/route.ts:9,20-21` | `RUNPOD_LLM_ENDPOINT_ID` is commented out in `.env` post-Groq-migration. Migrate this route to `groq-sdk` like `/api/chat` was. |
| 2 | "Generate Character Card" always produces the same generic stub, never a real LLM card | `app/api/personas/generate-card/route.ts:12,95,133` | Same cause/fix as #1 — migrate to Groq. |
| 3 | Deleting a memory in the Memory Center 404s | `app/memory/[id]/page.tsx:88` | Create `app/api/memory/[id]/route.ts` with a `DELETE` handler (no such route file exists). Match ownership-check pattern from `app/api/personas/route.ts` DELETE. |
| 4 | "Delete account and all data" button does nothing | `app/settings/page.tsx:104` | No `onClick` wired at all — needs the handler + a delete-account API route (doesn't exist yet). |
| 5 | 3D avatar shows a generic CDN test model, not the persona's own avatar | `components/Avatar3D.tsx:99,106` | `url` is hardcoded to `.../TalkingHead@1.7/avatars/brunette.glb` — a deliberate temp swap to test whether `/public/avatar.glb`'s blend shapes were the problem. Confirm, then restore `avatarUrl \|\| NEXT_PUBLIC_DEFAULT_AVATAR_URL \|\| "/avatar.glb"`. |
| 6 | Per-persona avatar URL may never apply even after #5 is fixed | `components/Avatar3D.tsx:125` (`}, []);`) | Load effect has empty deps, captures `avatarUrl` before `usePersona`'s async fetch resolves. Needs restructuring to react to `avatarUrl` changing. |
| 7 | Barge-in may not silence the avatar's mouth animation | `app/call/[id]/page.tsx:305-306` | `stopSpeaking`/`streamInterrupt` are unconfirmed TalkingHead.js method names, called optional-chained as a hedge. Verify against real usage or the TalkingHead source. |
| 8 | Rare double-submission of one utterance | `app/call/[id]/page.tsx:482-488` | 800ms accumulator-fallback timer can race a genuine late Deepgram final (arriving >800ms after `CloseStream`) — both can call `submitTurn()`. Narrow window, not eliminated. |
| 9 | Mic button can still get stuck disabled from 3 of 4 error paths | `app/call/[id]/page.tsx:319,376,397` (fixed for WS errors at `:366` via `ws.onopen`) | Deepgram-token-fetch failure, generic connect failure, and mic-permission-denial still have no recovery path within a session besides reload. |
| 10 | Memory Center's "Sessions" list is always empty | `db/schema.ts` `callSessions` table | Nothing in the codebase ever inserts into `callSessions` — `endCall()` in the call page only posts to `/api/memory/commit`. |
| 11 | Deleting a persona leaves orphaned Pinecone data | `app/api/personas/route.ts:123` | `// Phase 7: delete Pinecone namespace here` — comment only, not implemented. |
| 12 | "Cannot read properties of undefined (reading 'call')" webpack error, reported 3x | (varies by report) | Every proposed cause was checked against real code/build/SSR output and didn't hold up; never reproduced. **Don't trust the stated cause — verify against the actual file first.** |

## 4. Key Architecture Decisions (why, not just what)

- **Groq, not RunPod vLLM, for `/api/chat`:** RunPod needed manual `max_workers` scaling for cost control → 60-90s cold starts + an offline-stub dev mode. Groq is hosted, always warm, free tier covers all dev testing (14,400 req/day on the 8b-instant model). Only `/api/chat` was migrated — `/api/memory/commit` and `/api/personas/generate-card` still reference the now-unset RunPod LLM env vars (bugs #1, #2).
- **Short Deepgram project API keys, not `/v1/auth/grant` JWTs:** browsers can't set an `Authorization` header on a WebSocket handshake. The `Sec-WebSocket-Protocol` subprotocol trick (`new WebSocket(url, ["token", key])`) is the workaround — but that header has a length limit. Grant-token JWTs (~485 chars) got silently rejected; a `/v1/projects/{id}/keys` short-lived key (~40 chars) fits. **Rate-limited to 250 key-creations/day.**
- **`<script type="module" src="/load-talkinghead.js">`, not a webpack dynamic `import()`, for TalkingHead.js:** TalkingHead isn't on npm — it's a CDN-hosted ES module. A `import(/* webpackIgnore */ "https://...")` approach was tried first; a recurring, never-confirmed webpack crash was blamed on it across 3 separate bug reports (see #12). Switched to a static `/public` script file to remove the CDN URL from webpack's view entirely as a defensive measure, root cause still unconfirmed either way.
- **Click-to-toggle mic, not press-and-hold:** changed mid-Phase-5 by request. Required broadening the final-transcript state gate to accept `"thinking"` (not just `"listening"`) since the second click sets state synchronously before Deepgram's real final arrives, plus a `CloseStream` signal and an interim-transcript accumulator with an 800ms fallback (bug #8's source).
- **Mic capture never stops mid-call, only forwarding is gated:** required for barge-in — the recorder + WebSocket must already be live when state flips to `"speaking"` so a Deepgram final arriving mid-playback can interrupt.
- **`reactStrictMode: false`:** the call page's mount effect mints a rate-limited Deepgram key and opens a WebSocket; Strict Mode's dev-only double-invoke doubled that cost on every hot reload.

## 5. Critical Lessons

1. **Never trust a bug report's stated root cause without reading the actual file.** Three separate reports blamed this same webpack error on different files/mechanisms; none held up against the real code.
2. **Never rewrite `lib/audio.ts`'s `AudioQueue` as a class.** It's an interface + `createAudioQueue()` factory, used identically by both `chat/[id]` and `call/[id]` pages. Proposed twice, declined twice.
3. **Never emit `/api/chat` SSE as `{type:"token", token}`.** The client only reads `parsed.content` — that shape renders nothing.
4. **Never drop the `auth()` check from `/api/deepgram-token`.** It mints real, rate-limited (250/day) Deepgram keys — an open version is an abuse vector.
5. **`git diff` with nothing committed shows the whole session's changes, not just the latest edit.** Don't be misled by a huge diff into thinking one small change did all of that.
6. **A stale `.next` webpack cache produces the exact same "Cannot read properties of undefined (reading 'call')" signature as a real bundling bug** — especially after force-killing a dev server instead of a graceful shutdown. Always `rm -rf .next` + fresh build/dev before trusting the error points at your latest code change.
7. **Error-gate state (`micError` etc.) needs a path back to `null`/false on success**, or one transient failure disables a feature for the rest of the session. (`ws.onopen` was missing entirely until this was caught.)
8. **Trace boolean logic (De Morgan's law) before replacing a conditional a bug report calls "wrong."** `state !== "idle" && state !== "listening"` and `state === "thinking" || state === "speaking"` are the same expression for this 4-value type — one such "fix" request was actually a no-op that would have silently dropped legitimate `isMuted`/`micError` guards.
9. **Verify third-party API surfaces (TalkingHead.js etc.) against real docs, not just a pasted snippet** — but treat WebFetch summaries with some skepticism too (conflicting CDN version numbers were seen across two fetches of the same library).
10. **`runpod.serverless.start()` must be the unconditional last line of `handler.py` at module level**, never inside an `if __name__ == "__main__"` guard — RunPod's container entrypoint and local test mode hit the file the same way.
11. **Python base64 padding must be two statements**, never combined on one line (`%` gets parsed as string-formatting, not modulo, if you try).

## 6. Environment Variables (names only)

```
DATABASE_URL              Neon Postgres connection string
AUTH_SECRET                NextAuth secret
NEXT_PUBLIC_APP_URL         (appears unused in current code)
HF_TOKEN                   RunPod worker build-time only, not read by Next.js
RUNPOD_API_KEY              /api/tts, /api/memory/commit, /api/personas/generate-card
RUNPOD_LLM_ENDPOINT_ID       COMMENTED OUT — see bugs #1, #2
RUNPOD_LLM_MODEL             fallback string only, same two broken routes
RUNPOD_TTS_ENDPOINT_ID       /api/tts — required
GROQ_API_KEY                 /api/chat — required for real (non-stub) replies
GROQ_MODEL                   /api/chat, defaults llama-3.1-8b-instant
RUNPOD_OFFLINE                /api/chat stub toggle ONLY, does not touch /api/tts
DEEPGRAM_API_KEY              /api/deepgram-token — needs Member+ role
DEEPGRAM_PROJECT_ID           /api/deepgram-token — for /v1/projects/{id}/keys
PINECONE_API_KEY              /api/chat memories, /api/knowledge/ingest — degrades gracefully if absent
NEXT_PUBLIC_AVATURN_PROJECT   AvatarTab.tsx iframe subdomain
NEXT_PUBLIC_DEFAULT_AVATAR_URL  Avatar3D fallback — currently moot, see bug #5
```

## 7. File Quick Reference

```
app/api/chat/route.ts              Groq SSE chat endpoint, 5-zone system prompt
app/api/tts/route.ts                RunPod Chatterbox proxy, 600s timeout
app/api/deepgram-token/route.ts     Mints short-lived (~40 char) Deepgram project key
app/api/personas/route.ts           Persona CRUD, ownership-scoped
app/api/memory/commit/route.ts      BROKEN (bug #1) — RunPod fact extraction
app/api/personas/generate-card/route.ts  BROKEN (bug #2) — RunPod card gen
app/api/knowledge/ingest/route.ts   Chunk text → Pinecone persona-knowledge namespace
app/chat/[id]/page.tsx              Text chat, SSE, clause-level auto-play TTS
app/call/[id]/page.tsx              Live call — full state machine, see §9 below
app/memory/[id]/page.tsx            Memory + session viewer (delete btn broken, bug #3)
components/Avatar3D.tsx             TalkingHead wrapper, script-tag loaded (bugs #5-7)
lib/audio.ts                        AudioQueue factory (NOT a class), extractClauses, WAV encode
lib/pinecone.ts                     Knowledge + memory namespace query/upsert
lib/hooks.ts                        usePersona(id)
db/schema.ts                        users/personas/callSessions/memoriesLog
runpod-worker/handler.py            Chatterbox TTS worker — see §11 lesson #10
public/load-talkinghead.js          Static ES module loader for TalkingHead CDN import
```

## 8. RunPod Cost Control Rules

- Both LLM and TTS endpoints bill from worker **boot**, not from request start — `max_workers=0` stops new workers but doesn't kill ones already `initializing`; check the Workers tab if trying to stop spend immediately.
- TTS endpoint (`lzgcc945pqi103`): set `max_workers=0` when not testing, `max_workers=1` before a session. Cold start ~5-8 min, warm generation ~3-30s/clause.
- LLM RunPod endpoint is effectively unused now (Groq handles `/api/chat`) except for the two broken routes (bugs #1, #2) — no cost-control action needed there until those are migrated or re-enabled.
- Deepgram key minting: 250/day hard cap. Don't loop `npm run dev` restarts on the call page without reason.

## 9. Call Page State Machine

```
                 click (idle)
   ┌─────────┐ ───────────────► ┌────────────┐
   │  idle   │                  │ listening  │
   │         │ ◄─────────────── │            │
   └─────────┘   queue empties  └────────────┘
        ▲          (onended)           │
        │                              │ click (2nd) → sendAudio=false,
        │                              │   CloseStream sent, 800ms
        │                              │   accumulator-fallback armed
        │                              ▼
        │                       ┌────────────┐
        │        Deepgram final │  thinking  │  Groq SSE streaming,
        │◄───────(no audio ever)│            │  clause→TTS fetches racing
        │        started         └────────────┘
        │                              │ first TTS audio buffer ready
        │                              ▼
        │                       ┌────────────┐
        │   queue empties       │  speaking  │◄── mic forwarding RESUMES
        └───────────────────────│            │    here (barge-in window)
                                 └────────────┘
                                        │ Deepgram final arrives while
                                        │ speaking → abort turn, stop
                                        │ audio+avatar, submit new turn
                                        ▼
                                 back to listening
```
Mic (`getUserMedia`/`MediaRecorder`) is created once, lazily, on the very first click — never torn down until `endCall()`. Only `sendAudioRef.current` (forward chunks to Deepgram WS: yes/no) changes between states. Deepgram WebSocket itself stays open the whole call, kept alive via a `KeepAlive` control message every 8s.

## 10. `/api/chat` SSE Format (exact)

```
data: {"type":"emotion","emotion":"calm"}\n\n
data: {"content":"Hey "}\n\n
data: {"content":"there"}\n\n
data: {"content":", "}\n\n
...
data: [DONE]\n\n
```
On error, instead of more `content` events:
```
data: {"type":"error","message":"..."}\n\n
data: [DONE]\n\n
```
Client parses by buffering on `\n\n` boundaries (never assume one network read = one event) and only ever reads `parsed.type` (`"emotion"`/`"error"`) or `parsed.content` — nothing else.

## 11. Phase 7 — Ready-to-Use Prompt

```
Phase 7 go. Before starting, note these gaps already exist from earlier
phases (not new Phase 7 scope, but block it) — read
docs/CONTINUATION_CONTEXT.md and docs/CODE_REFERENCE_FOR_CLAUDE.md first:

1. app/api/memory/commit/route.ts and app/api/personas/generate-card/route.ts
   still call RunPod LLM via RUNPOD_LLM_ENDPOINT_ID, which is commented out
   in .env since the Groq migration — both silently stub out. Migrate both
   to groq-sdk the same way app/api/chat/route.ts was (same env vars, same
   useStub pattern).

2. Create app/api/memory/[id]/route.ts with a DELETE handler — the button
   in app/memory/[id]/page.tsx already posts to this URL but the route
   doesn't exist. Match the ownership-check pattern in
   app/api/personas/route.ts's DELETE handler (join through personas.userId).

3. Complete /api/memory/commit: after inserting facts into memoriesLog,
   also upsert them into the Pinecone "persona-memories" index (namespace =
   personaId) using lib/pinecone.ts's existing patterns, and store the
   returned id back into memoriesLog.pineconeId.

4. app/api/personas/route.ts DELETE (line ~123) has a stub comment for
   Pinecone namespace cleanup — implement it using
   lib/pinecone.ts's deleteKnowledgeNamespace(), and add the equivalent
   for the persona-memories namespace once #3 exists.

5. app/settings/page.tsx's "Delete account and all data" button has no
   onClick — wire it to a new account-deletion route that cascades through
   every persona a user owns (reuse the persona-delete logic from #4 per
   persona, then delete the user row — accounts/sessions cascade via FK).

6. db/schema.ts's callSessions table is never written to. Either start
   inserting a row in the call page's endCall() (startedAt/endedAt/
   transcriptJson/turnCount/durationSeconds), or decide this table is
   dead and remove memory/[id]/page.tsx's Sessions column — pick one,
   don't leave it half-wired.

7. Polish pass: loading skeletons (Skeleton component already exists in
   components/ui/index.tsx, underused), error boundaries, mobile
   responsiveness check on /chat and /call.

After: npm run build, fix all errors. Manual test: create a persona, chat,
call, check memory center shows real facts AND sessions, delete the
persona, confirm Postgres rows and Pinecone namespaces are actually gone.
```

## 12. What Works Right Now (verified this session)

- ✅ `/api/chat` — real Groq responses confirmed end-to-end (logged in as a real user, sent a message to persona "Aziz", got a persona-aware reply with correct `[emotion]` tag extraction and clean SSE `content` events).
- ✅ `/api/deepgram-token` — confirmed minting a real ~40-char key server-side (`[DEEPGRAM TOKEN] created key, api_key_id: ...` in logs), down from the broken 485-char JWT.
- ✅ `npm run build` — 0 errors as of the last change in this session.
- ✅ Home page and `/call/[id]` SSR — both verified clean (200, no webpack error) via authenticated fetch, multiple times, with fully cleared `.next`.
- ⚠️ Not verified by the agent (no real browser available in this environment): actual mic capture, Deepgram WS handshake success, TalkingHead 3D rendering, lip-sync, barge-in behavior. All of §3's bugs and §9's state machine are code-level, not browser-tested by the agent — verify these yourself.

## 13. Diagnostic Commands

```bash
# Clean rebuild (do this before trusting any webpack/SSR error report)
rm -rf .next && npm run build

# Fresh dev server
rm -rf .next && npm run dev

# Check nothing's already listening (Windows via Git Bash)
netstat -ano | grep -E ":300[0-9]" | grep LISTENING

# Authenticated API smoke test (PowerShell — Bash curl can't reach
# localhost reliably in this sandboxed environment, use PowerShell instead)
# 1. GET /api/auth/csrf → csrfToken
# 2. POST /api/auth/callback/credentials with {email, csrfToken, callbackUrl, json:"true"}
#    using -SessionVariable/-WebSession to persist the cookie
# 3. Now authenticated — hit any /api/* route or SSR page with -WebSession

# Find every file importing a given module (e.g. before changing lib/audio.ts)
grep -rn "from.*@/lib/audio" app/ components/ --include="*.tsx" --include="*.ts" -l

# .env variable names only, no values
grep -n "^[A-Z_]*=" .env | sed 's/=.*//'
```
