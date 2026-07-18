import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { CHATTERBOX_PRESETS } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 60; // TTS can take up to 60s on cold start

const RUNPOD_TTS_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_TTS_ENDPOINT_ID}/runsync`;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { personaId, text, emotion = "default" } = await req.json();

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

  if (!persona.voiceRefB64) {
    return NextResponse.json(
      { error: "No voice reference. Go to Create → Voice tab to record one." },
      { status: 422 }
    );
  }

  // Browser recordings/uploads can end up stored as a data URL
  // ("data:audio/wav;base64,AAAA..."). Python's base64.b64decode() chokes on
  // that prefix with "Incorrect padding" — strip it before it ever reaches
  // RunPod. (Belt and suspenders: the worker also defends against this.)
  let voiceB64 = persona.voiceRefB64;
  if (voiceB64.includes(",")) {
    voiceB64 = voiceB64.split(",")[1];
  }

  // Resolve Chatterbox params: persona overrides > emotion preset > default
  const emotionPreset = CHATTERBOX_PRESETS[emotion] ?? CHATTERBOX_PRESETS.default;
  const personaParams = (persona.voiceParamsJson ?? {}) as Partial<typeof emotionPreset>;
  const params = { ...emotionPreset, ...personaParams };

  const useStub =
    !process.env.RUNPOD_API_KEY ||
    !process.env.RUNPOD_TTS_ENDPOINT_ID ||
    process.env.RUNPOD_API_KEY === "stub" ||
    process.env.RUNPOD_OFFLINE === "true";

  if (useStub) {
    // Stub silence WAV so the Play button and offline chat dev mode agree
    return NextResponse.json({
      audio_base64:
        "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
      sample_rate: 24000,
      stub: true,
    });
  }

  // Never throw past this point — the Play button on the client treats any
  // {error} JSON body as a recoverable, per-message failure, not a crash.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

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
      ? "timed out after 90s. Cold starts can be slow — try again in a moment."
      : err instanceof Error
        ? err.message
        : "network error";
    console.error("RunPod TTS error:", reason);
    return NextResponse.json({ error: `TTS unavailable — ${reason}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

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
