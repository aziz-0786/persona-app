import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { personaId, audioB64 } = body;

  if (!personaId || !audioB64) {
    return NextResponse.json({ error: "Missing personaId or audioB64" }, { status: 400 });
  }

  // Ownership check
  const persona = await db.query.personas.findFirst({
    where: eq(personas.id, personaId),
  });
  if (!persona || persona.userId !== session.user.id) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  if (!persona.videoRefUrl) {
    return NextResponse.json(
      { error: "This persona has no template video. Add one in the persona editor to enable video avatar." },
      { status: 400 }
    );
  }

  const endpoint = process.env.RUNPOD_DUIX_ENDPOINT_ID;
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!endpoint || !apiKey) {
    return NextResponse.json(
      { error: "Duix endpoint not configured (RUNPOD_DUIX_ENDPOINT_ID or RUNPOD_API_KEY missing)" },
      { status: 503 }
    );
  }

  // Fetch persona's template video → base64
  let videoB64: string;
  try {
    const res = await fetch(persona.videoRefUrl);
    const buffer = await res.arrayBuffer();
    videoB64 = Buffer.from(buffer).toString("base64");
  } catch (e) {
    return NextResponse.json({ error: `Failed to fetch template video: ${e}` }, { status: 500 });
  }

  // Call RunPod Duix endpoint (synthesis takes 1-5 min, so long timeout)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 660_000); // 11 min

  try {
    const res = await fetch(`https://api.runpod.ai/v2/${endpoint}/runsync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: { video_b64: videoB64, audio_b64: audioB64 } }),
      signal: controller.signal,
    });
    const result = await res.json();

    if (result.output?.error) {
      return NextResponse.json({ error: result.output.error }, { status: 500 });
    }
    if (!result.output?.video_b64) {
      return NextResponse.json(
        { error: "No video returned from Duix endpoint", raw: result },
        { status: 500 }
      );
    }

    return NextResponse.json({
      videoB64: result.output.video_b64,
      taskId: result.output.task_id,
      durationS: result.output.duration_s,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      return NextResponse.json({ error: "Video synthesis timed out (>11 min)" }, { status: 504 });
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
