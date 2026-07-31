import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, chatMessages } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/history/[personaId]/chat — full chat_messages history, oldest first.
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

  const messages = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      emotion: chatMessages.emotion,
      isPinned: chatMessages.isPinned,
      pinnedBy: chatMessages.pinnedBy,
      autoTag: chatMessages.autoTag,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.personaId, personaId), eq(chatMessages.userId, session.user.id)))
    .orderBy(asc(chatMessages.createdAt));

  return NextResponse.json(messages);
}
