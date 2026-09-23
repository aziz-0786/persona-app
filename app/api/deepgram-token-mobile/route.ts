import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { mobileAuth } from "@/lib/mobile-auth";
import { callStartLimiter } from "@/lib/ratelimit";
import { getBalance } from "@/lib/credits";

export const dynamic = 'force-dynamic';
export const runtime = "nodejs";

// Mobile-only counterpart to /api/deepgram-token. That route deliberately
// mints a short project API key (not a JWT) because it feeds THIS repo's
// browser call page, which authenticates the WebSocket via the
// Sec-WebSocket-Protocol handshake header — a ~485-char JWT from
// /v1/auth/grant doesn't fit there and gets rejected. Native mobile WS
// clients aren't limited that way (they can set a real Authorization
// header), so this route uses /v1/auth/grant's JWT directly instead.
//
// Dual auth (session or Bearer JWT) — the Expo app has no NextAuth session
// cookie, only the JWT from /api/auth/mobile-token.
export async function GET(req: NextRequest) {
  console.log('[deepgram-token-mobile] called at', new Date().toISOString());
  const session = await auth();
  const userId = session?.user?.id ?? (await mobileAuth(req))?.userId;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Second line of defense — /api/calls/start also checks this, but a
  // zero-balance user should never even get a working Deepgram token.
  const balance = await getBalance(userId);
  if (balance === 0) {
    return NextResponse.json(
      { error: "No credits", redirectTo: "/dashboard/credits" },
      { status: 402 }
    );
  }

  const { success } = await callStartLimiter.limit(userId);
  if (!success) {
    return NextResponse.json(
      { error: "Too many requests. Wait before starting another call." },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Deepgram not configured" }, { status: 500 });
  }

  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    cache: 'no-store',
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

  // Field name unconfirmed — checking the documented/likely candidates in order.
  const token: string | undefined = data.access_token ?? data.token ?? data.key;

  if (!token) {
    console.error("[DEEPGRAM TOKEN MOBILE] response missing recognizable token field:", data);
    return NextResponse.json({ error: "Malformed token response" }, { status: 502 });
  }

  // Same response shape as /api/deepgram-token — mobile reads tokenData.token.
  return NextResponse.json({ token, expiresIn: 300 });
}
