import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { mobileAuth } from "@/lib/mobile-auth";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { deductCredits, getBalance } from "@/lib/credits";

export const runtime = "nodejs";

// POST /api/calls/end — closes the billing record opened by
// /api/calls/start and deducts credits for the actual duration. Dual auth
// (session or Bearer JWT) — the mobile call screen has no NextAuth session
// cookie.
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id ?? (await mobileAuth(req))?.userId;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { callId, durationSeconds } = (await req.json()) as {
    callId?: string;
    durationSeconds?: number;
  };
  if (!callId || typeof durationSeconds !== "number") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const [call] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.userId, userId)))
    .limit(1);
  if (!call) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Idempotent — a retried /api/calls/end (e.g. hangup fired twice) must not
  // double-deduct credits for the same call.
  if (call.status !== "active") {
    return NextResponse.json({ skipped: true });
  }

  let creditsUsed = Math.max(1, Math.ceil(durationSeconds));
  let remainingBalance: number;
  try {
    remainingBalance = await deductCredits(userId, creditsUsed, "call_usage", callId);
  } catch (err) {
    if (err instanceof Error && err.message === "Insufficient credits") {
      // Let them finish the call they're already on — drain to zero rather
      // than error out on a call that's already happened.
      creditsUsed = await getBalance(userId);
      remainingBalance = await deductCredits(userId, creditsUsed, "call_usage", callId);
    } else {
      throw err;
    }
  }

  await db
    .update(calls)
    .set({ status: "completed", endedAt: new Date(), durationSeconds, creditsUsed })
    .where(eq(calls.id, callId));

  return NextResponse.json({ creditsUsed, remainingBalance });
}
