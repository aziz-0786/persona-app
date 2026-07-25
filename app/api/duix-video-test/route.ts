import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { videoB64, audioB64 } = body;

  if (!videoB64 || !audioB64) {
    return NextResponse.json({ error: "Missing videoB64 or audioB64" }, { status: 400 });
  }

  const endpoint = process.env.RUNPOD_DUIX_ENDPOINT_ID;
  const apiKey = process.env.RUNPOD_API_KEY;

  if (!endpoint) {
    return NextResponse.json(
      { error: "RUNPOD_DUIX_ENDPOINT_ID not set in .env — add it after deploying the Duix RunPod endpoint" },
      { status: 503 }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 660_000);

  try {
    const res = await fetch(`https://api.runpod.ai/v2/${endpoint}/runsync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ input: { video_b64: videoB64, audio_b64: audioB64 } }),
      signal: controller.signal,
    });
    const result = await res.json();
    if (result.output?.error) {
      return NextResponse.json({ error: result.output.error }, { status: 500 });
    }
    return NextResponse.json({
      videoB64: result.output?.video_b64,
      taskId: result.output?.task_id,
      durationS: result.output?.duration_s,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      return NextResponse.json({ error: "Timed out" }, { status: 504 });
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
