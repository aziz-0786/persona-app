# Analysis: app/call/[id]/page.tsx

Source read in full (982 lines) at the current committed state (HEAD `aa47564`,
clean working tree — confirmed via `git diff HEAD`, no local edits). One note
before the analysis: the file currently has the warmup fallback timeout at
**22000ms**, not 35000ms — a prior task of mine bumped it to 35000ms
(commit `0680f33`), but a later commit `aa47564` ("Revert \"fix: increase
warmup timeout to 35s...\"") reverted it back to 22000ms, and a separate
commit `f613437` added `/api/warmup-db` — neither of those two commits came
from me. This analysis reflects the file as it stands now (22000ms).

---

## 1. Navigation to home

**Exactly one occurrence, line 929:**

```typescript
929:    router.push("/");
```

It's the last line of `endCall()` (lines 880-930). There is no `router.replace`
and no other `router.push` anywhere in the file (verified via grep for
`router\.(push|replace)|window\.location|redirect\(` — the only other match
is a comment mentioning "router.push" at line 886, not a call).

**Trigger condition:** `endCall()` is only wired to one place — the hangup
button, via `onEndCall={endCall}` on `<WallpaperCall>` (line 945). It is not
called from any effect, timer, or WebSocket handler. Its body is additionally
guarded by a ref so a second invocation (e.g. a double-tap) short-circuits
before reaching the `router.push`:

```typescript
888:    if (commitFiredRef.current) return;
889:    commitFiredRef.current = true;
```

**Conclusion:** the only way this page navigates home is the user pressing
the hangup button (or that handler being invoked twice, in which case only
the first invocation actually runs). No automatic/background path reaches
`router.push`.

---

## 2. Call-end timer

**There is no timer anywhere in this file that ends the call or navigates
home based on silence, no AI response, or elapsed time.**

All `setTimeout`/`setInterval` occurrences in the file (grepped exhaustively):

| Line | Call | Duration | What it does |
|---|---|---|---|
| 355 | `await new Promise((resolve) => setTimeout(resolve, 10))` | 10ms | A yield inside `submitTurn()` to let a just-issued `abort()` propagate before starting the new turn's work. Not call-ending. |
| 691 | `keepAliveIntervalRef.current = setInterval(...)` | 8000ms (`KEEPALIVE_INTERVAL_MS`, line 57) | Sends a Deepgram `KeepAlive` frame while `wsRef.current` is OPEN. Not call-ending. |
| 814 | `const warmupTimeout = setTimeout(() => markWarmupReady(), 22000)` | 22000ms | Fallback that flips `warmupReady` if the warmup POST hasn't resolved yet. Does not touch `endCall`/`router`. |
| 844 | `elapsedIntervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)` | 1000ms | Increments the `elapsed` display counter shown in the UI (`elapsedSeconds={elapsed}` at line 942). It runs unbounded — nothing ever reads `elapsed` to decide to end the call. |

None of these four call `endCall()`, `router.push`, or `router.replace`, and
none check "no AI response" or "silence duration" as an end-call condition.
If the call is ending unexpectedly, it is not this file's timers doing it.

---

## 3. WS reconnect loop

The full handler, lines 677-685:

```typescript
677:      ws.onclose = (event: CloseEvent) => {
678:        console.log("[CALL] WS closed — code:", event.code, "reason:", event.reason || "(none)", "wasClean:", event.wasClean);
679:        turnIdRef.current++;
680:        console.log("[CALL] WS reconnect, turnId advanced to", turnIdRef.current);
681:        if (keepAliveIntervalRef.current) {
682:          clearInterval(keepAliveIntervalRef.current);
683:          keepAliveIntervalRef.current = null;
684:        }
685:      };
```

**When `event.code === 1000` fires:** nothing branches on `event.code` at
all — the handler runs identically for every close code. It logs the close
details, increments `turnIdRef.current` (invalidating any in-flight
`submitTurn`/`flushClause` work still checking `turnIdRef.current === myTurnId`),
and clears the keep-alive interval. **That's it.**

**Does it reconnect?** No. Despite the log line's wording ("WS reconnect,
turnId advanced to..."), **this handler never calls `connectDeepgram()` and
never creates a new `WebSocket`.** Grepping the whole file for
`connectDeepgram` turns up exactly one call site:

```typescript
843:    connectDeepgram();
```

— inside the mount effect (lines 832-871), gated by `didInitRef` so it only
ever runs once per component instance. `ws.onclose` does not call
`connectDeepgram()`, does not call itself, and there is no recursion. The log
message name is misleading: it describes a "reconnect" that doesn't happen.
**This is a real bug, not just a log wording issue** — see section 5.

**Explaining "4 identical WS close+reconnect log pairs at the exact same
millisecond":** since `ws.onclose` can't recurse or self-trigger, 4
simultaneous close events require 4 *separate* `WebSocket` objects to have
existed and closed together. The only way to get 4 separate sockets is 4
separate runs of the mount effect that calls `connectDeepgram()` — which
means 4 separate *mounts* of the `CallPage` component (each mount gets its
own fresh `didInitRef`/`wsRef`/`turnIdRef` via `useRef`, so a genuine
component remount, not just a re-render, resets the "only once" guard).
`reactStrictMode` is confirmed `false` (see section 6), so Strict Mode's
dev-only double-invoke isn't the mechanism. The other thing in this exact
codebase's dev logs (seen repeatedly in earlier sessions against this same
file) that forces a full component remount is **Next.js Fast Refresh's
"full reload" fallback** (`⚠ Fast Refresh had to perform a full reload due
to a runtime error`) — each full reload re-executes the module and produces
a brand-new component instance with fresh refs, so 4 rapid full-reload
cycles (e.g. from 4 file saves in quick succession, or one save triggering a
cascading HMR failure) would produce exactly this pattern: 4 independent
sockets, each opened by a different mount, all logging a close within the
same event-loop tick if whatever killed them (a shared cause — e.g. all 4
being torn down together when yet another reload lands, or all hitting the
same external condition, such as Deepgram closing stale connections during a
project-wide token/rate issue) fired at once. I can't confirm this is *the*
mechanism without correlating actual timestamps against a dev server log
from that session, but it's the only explanation consistent with what this
file's code actually does — there is no in-file recursive or
render-triggered reconnect path.

---

## 4. Warmup gate

**Where `warmupReady` is set to `true`:** only inside `markWarmupReady()`
(lines 571-576):

```typescript
571:  function markWarmupReady() {
572:    if (warmupReadyRef.current) return;
573:    warmupReadyRef.current = true;
574:    setWarmupReady(true);
575:    maybeArmMic();
576:  }
```

Called from exactly two places, both inside the warmup `useEffect`
(lines 812-830): the fetch's `.then()` (line 823) and `.catch()` (line 827),
plus the 22s fallback `setTimeout` (line 814) if neither has fired yet.

**Exact flow after `warmupReady` becomes true:** `markWarmupReady()` calls
`maybeArmMic()` (lines 561-569):

```typescript
561:  function maybeArmMic() {
562:    if (!micGateRef.current || !warmupReadyRef.current) return;
563:    if (sendAudioRef.current) return;
564:    sendAudioRef.current = true;
565:    if (stateRef.current === "idle") setConvState("listening");
566:    // Auto-play the greeting once both the mic/WS are ready and the
567:    // greeting TTS fetch (fired on persona load) has settled.
568:    if (warmupDone) tryPlayGreeting();
569:  }
```

So: **the mic arms first, and only as a side effect of that does the
greeting play** — `sendAudioRef.current = true` (line 564) happens before
`tryPlayGreeting()` is even considered (line 568). But `maybeArmMic()` is a
no-op unless **both** `micGateRef.current` (WS open + mic permission granted,
set in `ws.onopen`'s `ensureMicReady().then()`, lines 669-672) **and**
`warmupReadyRef.current` are true — whichever of the two finishes last is
what actually triggers this whole sequence. And even then, the greeting only
plays if a **third**, independent condition (`warmupDone`, from the separate
Cartesia-greeting-TTS-prefetch effect at lines 768-800) is also already true.

**Does `warmupReady=true` ever cause a WS to be opened or closed?** No.
Neither `markWarmupReady()` nor `maybeArmMic()` nor `tryPlayGreeting()`
touches `wsRef`, calls `connectDeepgram()`, or calls `.close()`/
`new WebSocket(...)`. The DB/LLM warmup path and the Deepgram WS path are
fully independent subsystems that only synchronize through the
`maybeArmMic()` choke point (checking both refs) — neither can open or close
the other's connection.

**One real gap found while tracing this:** the greeting-prefetch effect has
its own *direct* path to `tryPlayGreeting()` that bypasses `maybeArmMic()`
entirely:

```typescript
787:        setWarmupDone(true);
788:        // WS may have already opened and armed the mic while this fetch was
789:        // still in flight — try the greeting now if so.
790:        if (wsRef.current?.readyState === WebSocket.OPEN) tryPlayGreeting();
```

This only checks that the WS is **open** — it does not check
`sendAudioRef.current`, `warmupReadyRef.current`, or `micGateRef.current`.
`tryPlayGreeting()` itself is idempotent (guarded by `greetingPlayedRef`,
line 744), so it can't double-fire, but it means there's a real code path
where the welcome-message audio can start playing purely because the WS
happens to be open, independent of whether the DB warmup has finished or the
mic has actually been armed for listening.

---

## 5. The blank scenario

After the greeting's TTS finishes (`queue.onended(() => setConvState("listening"))`,
lines 754-756) and the WS has closed once (`turnIdRef` advanced from 0 to 1
via line 679 in `ws.onclose`):

**What the component is doing:** per section 3, `ws.onclose` never reopens
the connection and never nulls out `wsRef.current` — grepping the file for
`wsRef.current =` shows it is only ever assigned in `connectDeepgram()`
(line 675, `wsRef.current = ws;`) and never reset to `null` anywhere,
including inside `ws.onclose`. So `wsRef.current` keeps pointing at the now-
`CLOSED` WebSocket object indefinitely.

**Is the mic armed?** `micStreamRef.current` and `mediaRecorderRef.current`
are completely untouched by `ws.onclose` — the `MediaRecorder` keeps firing
`ondataavailable` every 250ms exactly as before (line 723,
`recorder.start(250)`), and `sendAudioRef.current` is never reset to `false`
anywhere in the file (grepped — it's only ever set `true`, in `maybeArmMic()`
line 564). So the app's own bookkeeping still believes it is "armed and
sending." But the actual send is gated by:

```typescript
719:        if (e.data.size > 0 && sendAudioRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
720:          wsRef.current.send(e.data);
721:        }
```

Once `wsRef.current.readyState` is `WebSocket.CLOSED` (3), this condition is
permanently false — every subsequent audio chunk is silently dropped. No
error is raised: `ws.onerror` isn't necessarily fired by a normal close, and
nothing in `ws.onclose` sets `micError`.

**Does the component think the call has ended?** No — and that's the actual
problem. `state`/`stateRef` still reads `"listening"` (set by the greeting's
`onended`), `connecting` was already flipped to `false` back in `ws.onopen`,
and nothing in `ws.onclose` sets any error/ended state or calls `endCall()`.
The UI (green pulsing dot, "Listening..." text) looks completely normal.

**Net effect:** the call silently and permanently loses speech recognition
the moment the Deepgram WS closes for any reason, while the UI keeps showing
a healthy "listening" state forever. The user can keep talking and nothing
happens — no error, no reconnect, no visible sign anything is wrong. This
matches "the AI appears to stop in the middle" exactly, and it isn't a
reconnect *loop* — it's a reconnect that **never happens at all**.

---

## 6. React StrictMode

**Confirmed disabled**, in `next.config.mjs`:

```javascript
reactStrictMode: false,
```

with a comment directly above it explaining why:

> `/call/[id]` mints short-lived Deepgram API keys (rate-limited to 250/day)
> and opens a WebSocket on mount. Strict Mode's dev-only double-invoke
> (mount → cleanup → mount) doubles that real external-API cost on every
> reload — not worth it for what Strict Mode currently catches here.

This matches the in-file comment at lines 833-838 claiming the same thing —
independently verified by reading `next.config.mjs` directly rather than
trusting the comment.

**Would double-invoking the WS-opening effect explain the 4x close/reconnect
pattern?** Not via StrictMode specifically, since it's off. But the
*mechanism* StrictMode would have caused — the mount effect running more than
once and creating more than one `WebSocket` — is structurally the same
mechanism a Fast Refresh **full reload** produces (see section 3): both
remount the component from scratch, resetting `didInitRef` and allowing
`connectDeepgram()` to run again. StrictMode being off rules out the
"double-invoke on every normal reload" version of this, but doesn't rule out
repeated full-reload-driven remounts as the explanation for the observed 4x
pattern.
