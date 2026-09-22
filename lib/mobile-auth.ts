import { jwtVerify } from "jose";

// Verifies the session JWT minted by /api/auth/mobile-token (the Expo app's
// own auth flow — it doesn't have a NextAuth session cookie, so routes that
// need to serve both web and mobile check this as a fallback). Signed with
// AUTH_SECRET — the same secret NextAuth itself uses (this repo's .env has
// no separate NEXTAUTH_SECRET; see lib/auth.ts / .env.example).
export async function mobileAuth(
  request: Request
): Promise<{ userId: string; role: string } | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length);
  try {
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.sub !== "string") return null;
    return { userId: payload.sub, role: typeof payload.role === "string" ? payload.role : "user" };
  } catch {
    return null;
  }
}
