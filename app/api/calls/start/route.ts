import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { mobileAuth } from "@/lib/mobile-auth";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { getBalance } from "@/lib/credits";

export const runtime = "nodejs";

// POST /api/calls/start — opens a billing record for a call. Separate from
// /api/call-sessions (persona-scoped transcript history) — this is the
// user-scoped credits ledger's notion of a call. Dual auth (session or
// Bearer JWT) — the mobile call screen has no NextAuth session cookie.
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id ?? (await mobileAuth(req))?.userId;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { personaId, platform } = (await req.json().catch(() => ({}))) as {
    personaId?: string;
    platform?: string;
  };

  const balance = await getBalance(userId);
  if (balance === 0) {
    return NextResponse.json(
      { error: "No credits", redirectTo: "/dashboard/credits" },
      { status: 402 }
    );
  }

  const callId = crypto.randomUUID();
  await db.insert(calls).values({
    id: callId,
    userId,
    personaId: personaId ?? null,
    platform: platform ?? "web",
    status: "active",
    startedAt: new Date(),
  });

  return NextResponse.json({ callId, balance }, { status: 201 });
}
