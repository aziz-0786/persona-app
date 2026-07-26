import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
// Sequential TTS calls for 15 phrases can take a while on a cold worker —
// same reasoning as /api/tts's own long timeout.
export const maxDuration = 300;

const FILLER_PHRASES = [
  "Hmm.",
  "Yeah.",
  "Right.",
  "Oh.",
  "Mm.",
  "Let me think.",
  "Ah, okay.",
  "Sure.",
  "Interesting.",
  "Hmm, okay.",
  "Oh, right.",
  "Yeah, sure.",
  "Ah, I see.",
  "Mm-hmm.",
  "Got it.",
];

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const personaId = params.id;

  const [persona] = await db
    .select({ userId: personas.userId, voiceRefB64: personas.voiceRefB64 })
    .from(personas)
    .where(eq(personas.id, personaId))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (persona.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (process.env.RUNPOD_OFFLINE === "true") {
    return NextResponse.json({ success: true, count: 0 });
  }

  if (!persona.voiceRefB64) {
    // No voice reference yet (e.g. user hasn't finished the Voice tab) —
    // /api/tts would 422 on every one of the 15 calls below. Not an error,
    // just nothing to generate yet; the creator can retry later.
    return NextResponse.json({ success: true, count: 0 });
  }

  const fillerAudio: string[] = [];
  // Sequential, not Promise.all — deliberately avoids hammering RunPod with
  // 15 concurrent cold-start requests at once.
  for (const phrase of FILLER_PHRASES) {
    try {
      const res = await fetch(`${req.nextUrl.origin}/api/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // /api/tts requires a session — this internal call needs the
          // caller's cookie forwarded, since fetch() from a route handler
          // doesn't carry the browser's cookies automatically.
          Cookie: req.headers.get("cookie") ?? "",
        },
        body: JSON.stringify({ personaId, text: phrase, emotion: "default" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.audio_base64) {
        fillerAudio.push(data.audio_base64);
      } else {
        console.warn(`[generate-fillers] "${phrase}" failed:`, data.error ?? res.status);
      }
    } catch (err) {
      console.warn(`[generate-fillers] "${phrase}" threw:`, err);
    }
  }

  await db
    .update(personas)
    .set({ fillerAudioJson: JSON.stringify(fillerAudio) })
    .where(eq(personas.id, personaId));

  return NextResponse.json({ success: true, count: fillerAudio.length });
}
