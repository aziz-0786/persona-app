import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { mobileAuth } from "@/lib/mobile-auth";
import { getBalance } from "@/lib/credits";

export const runtime = "nodejs";

// GET /api/credits/balance — current user's credit balance. Accepts either
// a NextAuth session cookie (web) or an Authorization: Bearer JWT minted by
// /api/auth/mobile-token (mobile), tried as a fallback when there's no
// session.
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id ?? (await mobileAuth(req))?.userId;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ balance: await getBalance(userId) });
}
