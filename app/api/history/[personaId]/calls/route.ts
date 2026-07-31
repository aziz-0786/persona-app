import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, callSessions } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/history/[personaId]/calls — call_sessions history, newest first.
export async function GET(
  req: NextRequest,
  { params }: { params: { personaId: string } }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const personaId = params.personaId;

  const [persona] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const calls = await db
    .select({
      id: callSessions.id,
      startedAt: callSessions.startedAt,
      endedAt: callSessions.endedAt,
      durationSeconds: callSessions.durationSeconds,
      turnCount: callSessions.turnCount,
      transcriptJson: callSessions.transcriptJson,
      summaryText: callSessions.summaryText,
    })
    .from(callSessions)
    .where(eq(callSessions.personaId, personaId))
    .orderBy(desc(callSessions.startedAt));

  return NextResponse.json(calls);
}
