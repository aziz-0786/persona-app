import { NextResponse } from "next/server";

export const runtime = "nodejs";

// No auth required — this is a lightweight liveness ping fired from the
// login form (before a session exists) and from the WarmupManager interval
// on every authenticated page after that. It never generates audio, so
// there's nothing sensitive to gate behind a session check.
const RUNPOD_TTS_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_TTS_ENDPOINT_ID}/runsync`;

export async function POST() {
  if (process.env.RUNPOD_OFFLINE === "true") {
    return NextResponse.json({ status: "offline" });
  }

  // A cold RunPod worker can take far longer than this to actually finish
  // booting — this timeout only bounds how long THIS route waits before
  // giving up on the ping request itself, so the client's own 8s fetch
  // timeout (see useWarmupManager.ts) isn't left waiting on a route that's
  // still blocked on a RunPod request that will never return in time.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    // handler.py's warmup-mode shortcut (see runpod-worker/handler.py)
    // returns immediately without touching the model — this call exists
    // purely to keep/wake the worker, the response body is never used.
    await fetch(RUNPOD_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: { mode: "warmup" } }),
      signal: controller.signal,
    });
    return NextResponse.json({ status: "warm" }, { status: 200 });
  } catch (err) {
    // Never block the caller on a warmup failure — log and move on. Always
    // 200 regardless of cause (timeout or any other error) — this route's
    // whole contract is "never block, never fail the caller."
    console.warn("[warmup-runpod] ping failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ status: "warming" }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
