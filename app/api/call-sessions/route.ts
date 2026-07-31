import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, callSessions } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const runtime = "nodejs";

// POST /api/call-sessions — called from the (client-component) call page's
// endCall handler, which cannot import `db` directly.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { personaId, startedAt, endedAt, durationSeconds, turnCount, transcriptJson } =
    await req.json();

  if (!personaId) {
    return NextResponse.json({ error: "Missing personaId" }, { status: 400 });
  }

  // Ownership check — same pattern as the other persona-scoped routes.
  const [persona] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [row] = await db
    .insert(callSessions)
    .values({
      personaId,
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      endedAt: endedAt ? new Date(endedAt) : new Date(),
      durationSeconds: durationSeconds ?? null,
      turnCount: turnCount ?? 0,
      transcriptJson: transcriptJson ?? null,
      summaryText: null,
    })
    .returning({ id: callSessions.id });

  return NextResponse.json({ id: row.id });
}
