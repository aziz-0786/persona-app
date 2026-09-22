import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { adminActions } from "@/db/schema";
import { addCredits, deductCredits } from "@/lib/credits";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/credits/adjust — manual credit grant/deduction by an
// admin or owner. Every call is logged to admin_actions regardless of
// direction, with the reason required for audit purposes.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user.role !== "admin" && session.user.role !== "owner")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId, amount, reason } = (await req.json()) as {
    userId?: string;
    amount?: number;
    reason?: string;
  };

  if (!userId || !UUID_RE.test(userId)) {
    return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ error: "Amount must be a non-zero number" }, { status: 400 });
  }
  if (!reason || !reason.trim()) {
    return NextResponse.json({ error: "Reason is required" }, { status: 400 });
  }

  let newBalance: number;
  try {
    newBalance =
      amount > 0
        ? await addCredits(userId, amount, "admin_grant")
        : await deductCredits(userId, Math.abs(amount), "admin_deduction");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Adjustment failed" },
      { status: 400 }
    );
  }

  await db.insert(adminActions).values({
    adminId: session.user.id,
    targetUserId: userId,
    action: "credit_adjust",
    payload: { amount },
    reason: reason.trim(),
  });

  return NextResponse.json({ success: true, newBalance });
}
