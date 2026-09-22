import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { grantSignupCredits } from "@/lib/credits";

export const runtime = "nodejs";

const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;

// POST /api/auth/mobile-token — exchanges a Google ID token (from the Expo
// app's expo-auth-session flow) for this app's own signed session JWT.
// Deliberately not behind auth() — this IS the mobile auth entry point.
export async function POST(req: NextRequest) {
  const { googleToken } = (await req.json().catch(() => ({}))) as { googleToken?: string };
  if (!googleToken) return NextResponse.json({ error: "Missing googleToken" }, { status: 400 });

  // Never trust client-decoded claims — verify the ID token against Google
  // directly. tokeninfo also confirms the token is unexpired and well-formed.
  const verifyRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleToken)}`
  );
  if (!verifyRes.ok) return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });

  const tokenInfo = await verifyRes.json();

  // `aud` should match the mobile app's own Google OAuth client ID — without
  // this check, a valid ID token minted for ANY app (not just this one)
  // would be accepted here. Enforced only once EXPO_GOOGLE_CLIENT_ID is
  // configured server-side (it isn't yet — the Google Cloud Console client
  // is still a placeholder per this task's context); until then this is a
  // known gap that must be closed before real launch.
  const expectedAud = process.env.EXPO_GOOGLE_CLIENT_ID;
  if (expectedAud && tokenInfo.aud !== expectedAud) {
    return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });
  }

  const email: string | undefined = tokenInfo.email;
  const name: string | undefined = tokenInfo.name;
  if (!email) return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });

  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ email, name: name ?? null }).returning();
    await grantSignupCredits(user.id);
  }

  const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_TTL_SECONDS)
    .sign(secret);

  return NextResponse.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
}
