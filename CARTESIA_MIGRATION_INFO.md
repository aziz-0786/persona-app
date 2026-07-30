# Cartesia Migration — Reference Info

Read-only research pass. No code changed. Covers the current (Chatterbox/RunPod)
TTS pipeline end to end, as groundwork for a future Cartesia swap-in. Branch:
`feature/warmup-latency`.

---

## 1. Voice Reference Format

- **Storage column:** `personas.voiceRefB64` — `text` column in `db/schema.ts:69`, comment says "base64 encoded reference WAV". No separate Blob/URL variant for the voice reference itself — this is the only place it lives. (Contrast with `photoUrl`/`videoRefUrl`, which *are* URL-based — voice is the one asset still stored as inline base64 in the DB row.)
- **Format on disk/in-DB:** raw base64 of a **WAV** file (PCM), produced client-side by `lib/audio.ts`'s `processAudioToWav()` — the recording/upload is decoded via `AudioContext.decodeAudioData()` and immediately re-encoded to PCM16 WAV (`encodeWavPCM16()`) before ever being saved. So regardless of what the user recorded or uploaded (webm/opus mic recording, or an uploaded .wav/.mp3/.m4a/.ogg/.webm file), what actually reaches the DB is always WAV.
- **Data URL prefix:** Not applied at the point of creation (`ingestClip()` in `components/create/VoiceTab.tsx:144-164` calls `patchPersona({ voiceRefB64: result.base64 })` with the raw base64 string, no `data:audio/wav;base64,` prefix). However, both `/api/tts/route.ts` and `runpod-worker/handler.py` defensively strip a `data:...;base64,` prefix if one is present (`voiceB64.includes(",")` / `"," in voice_b64`) — so a data-URL-prefixed value is tolerated even though nothing in this codebase currently produces one for this field. Worth checking browser-recorded sources elsewhere (e.g. old data if manually edited) before assuming it's always prefix-free.
- **Sample rate / duration:** No fixed target sample rate is enforced at the point of capture — `encodeWavPCM16()` just uses whatever `audioBuffer.sampleRate` the source decoded to (i.e., the browser's `AudioContext` output rate, commonly 44100/48000Hz — not resampled down). Duration: the UI copy in `VoiceTab.tsx:172-174` and `:208-210` asks for **10–30 seconds of clean speech**, but nothing in `processAudioToWav()` enforces a min/max length — it just reports `durationSec` from the decoded buffer and flags noise level (`tooNoisy`, threshold `NOISY_DBFS_THRESHOLD = -40` dBFS in `lib/audio.ts`). No hard rejection on duration exists client- or server-side.
- **Fetch in `/api/tts`:** `app/api/tts/route.ts:41-44` — `db.select({ voiceRefB64: personas.voiceRefB64, voiceParamsJson: personas.voiceParamsJson }).from(personas).where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id))).limit(1)`. Ownership-checked in the same query (`userId` match), not a separate check.

---

## 2. Current `/api/tts` Contract

**Request body** the call page and chat page both send (identical shape — same route serves both):
```ts
{
  personaId: string,
  text: string,
  emotion?: string   // defaults to "default" server-side if omitted
}
```
Sent from:
- `app/call/[id]/page.tsx` — `flushClause()`'s fetch (line ~250-255) and the greeting-warmup `useEffect` (line ~626-634).
- `app/chat/[id]/page.tsx` — `fetchTtsAudio()` (line ~128-132), shared by the clause-streamed auto-play path and the manual Play/Retry button.
- `app/api/persona/[id]/generate-fillers/route.ts` — server-to-server call to the same route for each of 15 filler phrases.

**Response shape** (success):
```ts
{ audio_base64: string, sample_rate: number }
```
`sample_rate` defaults to `24000` if RunPod's response doesn't include one (`app/api/tts/route.ts:217-219`, and again independently in `runpod-worker/handler.py`'s own default). On error, the route always returns `{ error: string }` with a non-200 status (`400`/`404`/`422`/`502`/`504`) — every client-side call site treats any `{error}` JSON body (or a non-OK status, or a missing `audio_base64`) as a recoverable per-call failure, never a crash.

**Client-side decode:** Both pages call the same helper, `decodeB64ToAudioBuffer(b64, ctx)` in `lib/audio.ts:133-138` — `ctx.decodeAudioData(base64ToArrayBuffer(b64))`. This uses the browser's native WAV/audio decoder and **resamples automatically to the `AudioContext`'s own sample rate** — the client never reads or trusts the `sample_rate` field from the response for playback; it's informational only (used just for `greetingSampleRateRef` bookkeeping in the call page, never actually applied anywhere). This means the pipeline is already fairly TTS-provider-agnostic on sample rate — whatever Cartesia returns, as long as it's a container `decodeAudioData` can parse (WAV, MP3, etc.), no client changes should be needed here.

**Emotion → Chatterbox params mapping** (`lib/utils.ts:38-50`, `CHATTERBOX_PRESETS`):

| emotion | exaggeration | cfg_weight | temperature |
|---|---|---|---|
| happy | 0.8 | 0.3 | 0.9 |
| amused | 0.7 | 0.3 | 0.9 |
| calm | 0.3 | 0.5 | 0.7 |
| thinking | 0.3 | 0.5 | 0.7 |
| sad | 0.4 | 0.6 | 0.6 |
| angry | 0.9 | 0.3 | 1.0 |
| surprised | 0.8 | 0.4 | 0.9 |
| default | 0.5 | 0.5 | 0.8 |

Resolution order in the route (`app/api/tts/route.ts:74-76`): `{ ...emotionPreset, ...personaParams }` — a persona's own `voiceParamsJson` override (if set) wins over the emotion preset, which wins over `default`. These three params (`exaggeration`/`cfg_weight`/`temperature`) are Chatterbox-specific concepts with no direct Cartesia equivalent — this whole table and the `voiceParamsJson` schema shape are the part most tightly coupled to the current provider (see Section 6).

**Timeout / polling / retry:**
- 600-second `AbortController` timeout on the initial RunPod `runsync` call (`maxDuration = 600` on the route, matched to the abort timeout — `app/api/tts/route.ts:19,94-95`).
- If RunPod returns `IN_QUEUE`/`IN_PROGRESS` (cold start not finished inside `runsync`'s own wait window), the route polls `GET /status/{jobId}` every 3s for up to 5 minutes (`app/api/tts/route.ts:165-200`).
- No client-side retry logic anywhere — a failed clause is simply dropped (see Section 7); the user must manually retry via a UI action (Retry button on chat, or re-tap mic on call).

---

## 3. Audio Playback Client Side

- **`AudioQueue` interface** (`lib/audio.ts:140-148`): `add(buffer: AudioBuffer)`, `onended(cb)`, `onBuffer(cb)`, `stop()`, `clear()`. It only ever consumes **decoded `AudioBuffer` objects** — never raw base64 or URLs directly. Both call sites decode via `decodeB64ToAudioBuffer()` first, then call `queue.add(buffer)`.
- **Gapless playback mechanism** (`createAudioQueue()`, `lib/audio.ts:153-202`): an internal array of pending `AudioBuffer`s; `playNext()` shifts one off, wires `source.onended = playNext` so the next buffer starts the instant the previous one finishes — genuinely gapless, no manual crossfade currently exists. `onended` (the queue-level "all done" callback) is a **single overwritable slot**, not a subscriber list — only one callback can be registered at a time, and it fires once when the queue drains to empty.
- **AudioContext sample rate:** Not fixed/forced — `getAudioContext()` in both `app/call/[id]/page.tsx` and `app/chat/[id]/page.tsx` does `new (window.AudioContext || webkitAudioContext)()` with no `sampleRate` option, so it runs at whatever the OS/browser's default output device rate is (typically 44100 or 48000Hz). `decodeAudioData` resamples the incoming WAV to match automatically.
- **Clause splitting** (`extractClauses()`, `lib/audio.ts:214-230`): splits on a fixed boundary-character set `[",", ".", "!", "?", ";", ":", "—"]`, with a **minimum of 4 words** since the last split before a boundary counts as a valid clause break (`MIN_CLAUSE_WORDS = 4`). No maximum length cap. Untrimmed substrings are preserved so `clauses.join("").length` always equals exactly how much of the input text was consumed — callers rely on this to compute the remainder via `text.slice(clauses.join("").length)`.
- **Where a crossfade would hook in:** there's no crossfade today — `playNext()` does a hard buffer-to-buffer handoff via chained `source.onended` calls. A crossfade would need to replace the single-`AudioBufferSourceNode`-at-a-time model with two overlapping sources and a `GainNode` ramp between them, timed against each buffer's known duration — a nontrivial restructuring of `playNext()`, not a drop-in addition. The `onended` (queue-drained) callback registration point itself (used identically by both pages, plus `tryPlayGreeting()` in the call page) is a clean, provider-agnostic integration point regardless of crossfade — it's already the single place both pages hook "what happens when all queued audio for this turn/message is done."

---

## 4. Persona Creation Flow

- **Component:** `components/create/VoiceTab.tsx` — one of the tabs in the persona creation wizard (`app/create/page.tsx` orchestrates `tabProps = { persona, patchPersona, onNext }` shared across all tabs). Two capture paths, both converging on the same save call:
  - **Upload** (primary, drag-drop or file-picker) — accepts `.wav,.mp3,.m4a,.ogg,.webm`.
  - **Record live** (secondary) — `MediaRecorder` via `navigator.mediaDevices.getUserMedia({ audio: true })`, `pickMimeType()` picks the first browser-supported codec from `["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]`.
  - Both paths call `ingestClip(blob, label)` (`VoiceTab.tsx:144-164`), which runs `processAudioToWav()` (decode → re-encode as PCM16 WAV, compute RMS/dBFS/duration), then immediately `patchPersona({ voiceRefB64: result.base64 })` — **the DB save happens right when the clip is processed, not deferred to a later "save" step.**
- **On save:** `patchPersona()` (defined in `app/create/page.tsx:103-113`) does `fetch("/api/personas", { method: "PATCH", body: JSON.stringify({ id: personaId, ...updates }) })`. (The PATCH handler itself lives in `app/api/personas/route.ts`, not read in this pass — only the `DELETE` handler in `app/api/personas/[id]/route.ts` was in scope — but the call site confirms the exact endpoint/method/shape.) This is a generic "patch any persona field" endpoint, not voice-specific — `voiceRefB64` is just one of the fields it can set.
- **Post-creation hook where a Cartesia clone call could fire:** The closest existing analog is `handleApprove()` in `components/create/ReviewTab.tsx:33-47` — on approving the finished persona, it fires `fetch(\`/api/persona/${persona.id}/generate-fillers\`, { method: "POST" }).catch(() => {})`, **not awaited**, before `router.push("/")`. That route (`app/api/persona/[id]/generate-fillers/route.ts`) already re-fetches `voiceRefB64` from the DB and does 15 sequential `/api/tts` calls to pre-generate filler audio. A Cartesia **voice-clone registration** call (as opposed to a plain TTS call) would most naturally fire from one of two places:
  1. Directly inside `ingestClip()` in `VoiceTab.tsx`, right after `patchPersona({ voiceRefB64 })` succeeds — clone the voice the moment a usable reference is saved, store whatever clone ID Cartesia returns back onto the persona row.
  2. Or, matching the existing "defer expensive work to approval" pattern, inside `generate-fillers`'s route or a sibling route triggered from `handleApprove()` — clone once, right before/alongside the filler-phrase generation, so a persona is never cloned twice if the user re-records mid-wizard.
  Neither hook exists today — this is purely where it would slot in given the current shape.

---

## 5. Schema

Full current `personas` table (`db/schema.ts:60-94`):

```ts
export const personas = pgTable("personas", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  relationship: text("relationship"), // e.g. "friend", "mentor", "self"
  bioJson: json("bio_json").$type<Record<string, string>>(), // 25Q answers
  characterCardText: text("character_card_text"), // generated 300-600 token card
  voiceRefB64: text("voice_ref_b64"), // base64 encoded reference WAV
  voiceParamsJson: json("voice_params_json").$type<{
    exaggeration: number;
    cfg_weight: number;
    temperature: number;
  }>(),
  avatarUrl: text("avatar_url"), // Avaturn GLB URL or uploaded GLB path
  avatarType: text("avatar_type").$type<"avaturn" | "upload" | "vrm" | "default">(),
  photoUrl: text("photo_url"), // persona photo — wallpaper background on call + chat pages
  videoRefUrl: text("video_ref_url"), // template video — Duix face2face synthesis (optional, unlocks video avatar)
  fillerAudioJson: text("filler_audio_json"), // JSON array of 15 pre-generated filler-phrase audio URLs/base64 strings
  consentVersion: text("consent_version"), // e.g. "1.0"
  consentScopeJson: json("consent_scope_json").$type<{
    voiceCloning: boolean;
    shareWithOthers: boolean;
    persistentStorage: boolean;
  }>(),
  consentSignedAt: timestamp("consent_signed_at", { withTimezone: true }),
  consentAudioB64: text("consent_audio_b64"), // recorded spoken consent WAV
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Note `voiceParamsJson`'s typed shape (`exaggeration`/`cfg_weight`/`temperature`) is **Chatterbox-specific** — a Cartesia migration would need either a new column (e.g. `cartesiaVoiceId text`) or a reshaping of this JSON blob to whatever Cartesia's per-voice control parameters are (Cartesia's params are a different concept entirely — likely just a clone/voice ID reference rather than generation-time knobs like these).

**How columns were added:** `npx drizzle-kit push` (confirmed via `package.json`'s `"db:push": "drizzle-kit push"` script), diffing the live Postgres DB directly against this schema file — **not** `drizzle-kit generate` + a migrations folder. `db/migrations/` is empty/untracked in this repo (no `git log` history for it), so `generate` would only ever produce a no-op `CREATE TABLE IF NOT EXISTS` "migration 0000" against the already-existing live DB. Any new Cartesia-related column should be added to this schema file and applied with `npm run db:push` (or `npx drizzle-kit push` directly), the same way every prior column here was added.

---

## 6. Env + Config

All `process.env.*` keys referenced anywhere in the codebase (via grep across `.ts`/`.tsx`/`.py`):

| Key | Where used |
|---|---|
| `DATABASE_URL` | `db/index.ts`, `drizzle.config.ts` |
| `NEXT_PUBLIC_AVATURN_PROJECT` | `components/create/AvatarTab.tsx` |
| `GROQ_API_KEY` | `app/api/chat/route.ts` |
| `GROQ_MODEL` | `app/api/chat/route.ts` |
| `OPENAI_API_KEY` | `app/api/chat/route.ts` |
| `PINECONE_API_KEY` | `app/api/chat/route.ts`, `app/api/personas/[id]/route.ts`, `app/api/users/route.ts`, `app/api/knowledge/ingest/route.ts`, `lib/pinecone.ts` |
| `RUNPOD_OFFLINE` | `app/api/chat/route.ts`, `app/api/warmup-runpod/route.ts`, `app/api/tts/route.ts`, `app/api/persona/[id]/generate-fillers/route.ts` |
| `RUNPOD_DUIX_ENDPOINT_ID` | `app/api/duix-video/route.ts`, `app/api/duix-video-test/route.ts` |
| `RUNPOD_API_KEY` | `app/api/duix-video/route.ts`, `app/api/duix-video-test/route.ts`, `app/api/memory/commit/route.ts`, `app/api/warmup-runpod/route.ts`, `app/api/tts/route.ts`, `app/api/personas/generate-card/route.ts`, `scripts/test-tts.ts` |
| `RUNPOD_LLM_ENDPOINT_ID` | `app/api/memory/commit/route.ts`, `app/api/personas/generate-card/route.ts` |
| `RUNPOD_LLM_MODEL` | `app/api/memory/commit/route.ts`, `app/api/personas/generate-card/route.ts` |
| `RUNPOD_TTS_ENDPOINT_ID` | `app/api/warmup-runpod/route.ts`, `app/api/tts/route.ts`, `scripts/test-tts.ts` |
| `BLOB_READ_WRITE_TOKEN` | `app/api/upload/route.ts` |
| `NEXT_PUBLIC_WARMUP_ENABLED` | `hooks/useWarmupManager.ts` |
| `DEEPGRAM_API_KEY` | `app/api/deepgram-token/route.ts` |
| `DEEPGRAM_PROJECT_ID` | `app/api/deepgram-token/route.ts` |
| `EMAIL_SERVER` | `lib/auth.ts` |
| `EMAIL_FROM` | `lib/auth.ts` |

(This matches `.env`'s key names — confirmed no value content is reproduced above, only names.)

**Where TTS provider selection would naturally live:** There is currently **no provider-switch abstraction at all** — `/api/tts/route.ts` hardcodes the RunPod/Chatterbox call path directly inline (no `if (provider === "cartesia")` branch, no factory function, no `TTS_PROVIDER` env var). The closest existing precedent for a provider-switch pattern in this codebase is `app/api/chat/route.ts`'s `callLLM()` (`app/api/chat/route.ts:160-201`) — it tries Groq first, falls back to OpenAI, controlled by which API keys are present rather than an explicit "provider" env var. A Cartesia migration would most naturally follow that same shape: a `callTts()`-style function inside `/api/tts/route.ts` that branches on (for example) a new `CARTESIA_API_KEY` env var being present, rather than retrofitting a formal provider-enum system that doesn't exist anywhere else in this codebase today.

---

## 7. Call Page Audio Entry Points

**`app/call/[id]/page.tsx`** calls `/api/tts` from exactly two places:
1. **Greeting warmup ping** — the `useEffect` that fires the instant `persona` loads (line ~621-654), text hardcoded to `"Hey, good to hear from you."`, `emotion: "happy"`. This both warms the RunPod worker *and* pre-fetches the actual greeting audio played later via `tryPlayGreeting()` once the user taps "Tap to connect."
2. **Per-turn clause synthesis** — `flushClause()` inside `submitTurn()` (line ~244-267), called once per extracted clause as the LLM's SSE response streams in, plus once more for any trailing fragment after the stream ends. This is the only place real conversational turns produce audio.

There is no other call-page TTS entry point — no separate "retry" fetch distinct from a fresh `flushClause()` call, and no manual play button on the call page (unlike chat).

**`app/chat/[id]/page.tsx`** calls `/api/tts` from:
1. **Auto-play clause streaming** — `flushClause()` inside `sendMessage()` (line ~184-220), same clause-by-clause pattern as the call page, triggered as the assistant's SSE response streams in.
2. **Manual Play button** — `playAudio(msg)` (line ~363-406), used both for the initial Play click on a message that has no cached `audioB64` yet, and for the **Retry** button shown when `msg.ttsFailed` is true (same function, re-fetches since there's no cached failed audio to reuse).

Both pages' TTS calls funnel through the identical shared helper pattern (`fetchTtsAudio`-equivalent logic), and both ultimately hit the same single `/api/tts` route — there is no separate TTS route or code path per page.
