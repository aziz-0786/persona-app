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
    });
  } catch (err) {
    // Never block the caller on a warmup failure — log and move on.
    console.warn("[warmup-runpod] ping failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ status: "pinged" }, { status: 200 });
}
