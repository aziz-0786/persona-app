import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { mobileAuth } from "@/lib/mobile-auth";
import { db } from "@/db";
import { creditTransactions } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/credits/history — last 10 credit transactions for the current
// user. Same dual auth as /api/credits/balance (session or Bearer JWT).
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id ?? (await mobileAuth(req))?.userId;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(10);

  return NextResponse.json(rows);
}
