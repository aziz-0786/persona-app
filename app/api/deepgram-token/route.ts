import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  const projectId = process.env.DEEPGRAM_PROJECT_ID;

  if (!apiKey || !projectId) {
    return NextResponse.json({ error: "Deepgram not configured" }, { status: 500 });
  }

  // /v1/auth/grant mints a JWT (~485 chars) — too long to fit in the
  // Sec-WebSocket-Protocol handshake header, which browsers need since they
  // can't set a custom Authorization header on a WebSocket. A short-lived
  // project API key (~40 char alphanumeric) from /v1/projects/{id}/keys
  // fits and is the documented workaround for browser WS auth. Rate-limited
  // to 250 key creations/day, so keep the TTL short and don't over-call this.
  const res = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      comment: "temp-browser-key",
      scopes: ["usage:write"],
      time_to_live_in_seconds: 60,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[DEEPGRAM TOKEN] failed:", res.status, text);
    return NextResponse.json({ error: "Token creation failed" }, { status: 500 });
  }

  const data = await res.json();
  if (!data.key) {
    console.error("[DEEPGRAM TOKEN] response missing key:", data);
    return NextResponse.json({ error: "Malformed token response" }, { status: 502 });
  }

  console.log("[DEEPGRAM TOKEN] created key, api_key_id:", data.api_key_id);

  return NextResponse.json({ token: data.key, expiresIn: 60 });
}
