import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { CHATTERBOX_PRESETS } from "@/lib/utils";

// RunPod TTS endpoint: lzgcc945pqi103
// Set max_workers=0 on dashboard when not testing to stop billing.
// Set max_workers=1 before any TTS test session.
// Cold start: ~5-8 min. Warm generation: ~3-30s per clause.

export const runtime = "nodejs";
// Must stay >= the AbortController timeout below (600s) — otherwise the
// platform kills the function before our own timeout ever gets a chance to.
// Phase 4 (Option A): a synchronous 10-minute wait covers cold starts without
// an architecture change. Phase 5 should switch to /run + poll /status/{id}
// instead of blocking a single request for up to 10 minutes.
export const maxDuration = 600;

const RUNPOD_TTS_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_TTS_ENDPOINT_ID}/runsync`;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { personaId, text, emotion = "default" } = body;

  console.log("[TTS] route hit, body keys:", Object.keys(body));
  console.log("[TTS] text length:", text?.length ?? 0);
  console.log("[TTS] RUNPOD_OFFLINE:", process.env.RUNPOD_OFFLINE);

  if (!personaId || !text) {
    return NextResponse.json({ error: "Missing personaId or text" }, { status: 400 });
  }

  // Load persona voice ref (verify ownership)
  const [persona] = await db
    .select({ voiceRefB64: personas.voiceRefB64, voiceParamsJson: personas.voiceParamsJson })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const voiceRefB64 = persona.voiceRefB64;
  console.log("[TTS] voiceRefB64 length:", voiceRefB64?.length ?? 0);

  if (!voiceRefB64) {
    // Sending an empty voice_b64 to RunPod fails silently on the worker side
    // (see CLAUDE.md persona shape notes) — reject here with a clear reason
    // instead.
    return NextResponse.json(
      { error: "No voice reference. Go to Create → Voice tab to record one." },
      { status: 422 }
    );
  }

  // Browser recordings/uploads can end up stored as a data URL
  // ("data:audio/wav;base64,AAAA..."). Python's base64.b64decode() chokes on
  // that prefix with "Incorrect padding" — strip it before it ever reaches
  // RunPod. (Belt and suspenders: the worker also defends against this.)
  let voiceB64 = voiceRefB64;
  if (voiceB64.includes(",")) {
    voiceB64 = voiceB64.split(",")[1];
  }

  // Resolve Chatterbox params: persona overrides > emotion preset > default
  const emotionPreset = CHATTERBOX_PRESETS[emotion] ?? CHATTERBOX_PRESETS.default;
  const personaParams = (persona.voiceParamsJson ?? {}) as Partial<typeof emotionPreset>;
  const params = { ...emotionPreset, ...personaParams };

  // Offline/stub short-circuit removed — TTS always calls RunPod now,
  // regardless of RUNPOD_OFFLINE or missing credentials.
  const useStub = false;
  console.log("[TTS] useStub:", useStub, {
    hasApiKey: !!process.env.RUNPOD_API_KEY,
    hasEndpointId: !!process.env.RUNPOD_TTS_ENDPOINT_ID,
    offlineFlag: process.env.RUNPOD_OFFLINE,
  });

  console.log("[TTS] personaId:", personaId);
  console.log("[TTS] sending to RunPod, text:", text?.slice(0, 50));

  // Never throw past this point — the Play button on the client treats any
  // {error} JSON body as a recoverable, per-message failure, not a crash.
  // 600s covers a cold start (~5-8 min); Phase 5 should replace this with
  // /run + poll /status/{id} instead of a single long-blocking request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);

  let runpodRes: Response;
  try {
    runpodRes = await fetch(RUNPOD_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          text,
          voice_b64: voiceB64,
          exaggeration: params.exaggeration,
          cfg_weight: params.cfg_weight,
          temperature: params.temperature,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const reason = isTimeout
      ? "timed out after 600s. If the worker is scaled to max_workers=0 it will never dequeue — check the RunPod dashboard."
      : err instanceof Error
        ? err.message
        : "network error";
    console.error("RunPod TTS error:", reason);
    return NextResponse.json({ error: `TTS unavailable — ${reason}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  console.log("[TTS] RunPod status:", runpodRes.status);

  if (!runpodRes.ok) {
    const errText = await runpodRes.text().catch(() => "");
    console.error("RunPod TTS error:", runpodRes.status, errText);
    return NextResponse.json(
      { error: `TTS unavailable — RunPod returned ${runpodRes.status}. Try again in a moment.` },
      { status: 502 }
    );
  }

  let data: { output?: { audio_base64?: string; sample_rate?: number }; audio_base64?: string; sample_rate?: number };
  try {
    data = await runpodRes.json();
  } catch (err) {
    console.error("RunPod TTS malformed response:", err);
    return NextResponse.json({ error: "TTS unavailable — malformed response" }, { status: 502 });
  }

  console.log("[TTS] RunPod keys:", Object.keys(data ?? {}));
  console.log("[TTS] RunPod output keys:", Object.keys(data?.output ?? {}));
  console.log(
    "[TTS] audio_base64 length:",
    data?.output?.audio_base64?.length ?? data?.audio_base64?.length ?? 0
  );

  // RunPod runsync wraps output in { output: { ... } }
  const output = data.output ?? data;

  if (!output.audio_base64) {
    console.error("RunPod TTS response missing audio_base64:", data);
    return NextResponse.json({ error: "TTS unavailable — empty response" }, { status: 502 });
  }

  return NextResponse.json({
    audio_base64: output.audio_base64,
    sample_rate: output.sample_rate ?? 24000,
  });
}
