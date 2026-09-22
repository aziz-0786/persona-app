import { NextRequest, NextResponse } from "next/server";
import { mobileAuth } from "@/lib/mobile-auth";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/calls/history — mobile-only endpoint (Authorization: Bearer JWT
// from /api/auth/mobile-token). The web app already has its own call
// history UI backed by the call_sessions table.
export async function GET(req: NextRequest) {
  const mobile = await mobileAuth(req);
  if (!mobile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(calls)
    .where(eq(calls.userId, mobile.userId))
    .orderBy(desc(calls.startedAt))
    .limit(50);

  return NextResponse.json(rows);
}
