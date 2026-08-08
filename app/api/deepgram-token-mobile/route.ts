import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

// Mobile-only counterpart to /api/deepgram-token. That route deliberately
// mints a short project API key (not a JWT) because it feeds THIS repo's
// browser call page, which authenticates the WebSocket via the
// Sec-WebSocket-Protocol handshake header — a ~485-char JWT from
// /v1/auth/grant doesn't fit there and gets rejected. Native mobile WS
// clients aren't limited that way (they can set a real Authorization
// header), so this route uses /v1/auth/grant's JWT directly instead.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Deepgram not configured" }, { status: 500 });
  }

  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[DEEPGRAM TOKEN MOBILE] failed:", res.status, text);
    return NextResponse.json({ error: "Token creation failed" }, { status: 500 });
  }

  const data = await res.json();
  console.log("[DEEPGRAM TOKEN MOBILE] full response:", JSON.stringify(data));

  // Field name unconfirmed until the log above is actually observed —
  // checking the documented/likely candidates in order.
  const token: string | undefined = data.access_token ?? data.token ?? data.key;

  if (!token) {
    console.error("[DEEPGRAM TOKEN MOBILE] response missing recognizable token field:", data);
    return NextResponse.json({ error: "Malformed token response" }, { status: 502 });
  }

  // Same response shape as /api/deepgram-token — mobile reads tokenData.token.
  return NextResponse.json({ token, expiresIn: 300 });
}
