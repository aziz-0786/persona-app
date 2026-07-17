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
    return NextResponse.json({ error: "No voice reference set for this persona" }, { status: 422 });
  }

  // Resolve Chatterbox params: persona overrides > emotion preset > default
  const emotionPreset = CHATTERBOX_PRESETS[emotion] ?? CHATTERBOX_PRESETS.default;
  const personaParams = (persona.voiceParamsJson ?? {}) as Partial<typeof emotionPreset>;
  const params = { ...emotionPreset, ...personaParams };

  if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_TTS_ENDPOINT_ID) {
    // Return a stub silence WAV for Phase 1 testing (44 bytes minimal WAV header)
    return NextResponse.json({
      audio_base64:
        "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
      sample_rate: 24000,
      stub: true,
    });
  }

  const runpodRes = await fetch(RUNPOD_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        text,
        voice_b64: persona.voiceRefB64,
        exaggeration: params.exaggeration,
        cfg_weight: params.cfg_weight,
        temperature: params.temperature,
      },
    }),
  });

  if (!runpodRes.ok) {
    const err = await runpodRes.text();
    console.error("RunPod TTS error:", err);
    return NextResponse.json({ error: "TTS failed" }, { status: 502 });
  }

  const data = await runpodRes.json();

  // RunPod runsync wraps output in { output: { ... } }
  const output = data.output ?? data;

  return NextResponse.json({
    audio_base64: output.audio_base64,
    sample_rate: output.sample_rate ?? 24000,
  });
}
