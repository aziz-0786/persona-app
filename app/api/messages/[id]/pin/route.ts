import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { chatMessages, pinnedMemories } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const runtime = "nodejs";

// PATCH /api/messages/[id]/pin — toggle a chat message's pinned state.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const messageId = params.id;

  const [message] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1);

  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (message.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const nextPinned = !message.isPinned;

  if (nextPinned) {
    await db
      .update(chatMessages)
      .set({ isPinned: true, pinnedBy: "user" })
      .where(eq(chatMessages.id, messageId));

    await db.insert(pinnedMemories).values({
      personaId: message.personaId,
      userId: message.userId,
      sourceType: "chat",
      sourceId: message.id,
      content: message.content,
      autoTag: null,
      pinnedBy: "user",
    });
  } else {
    await db
      .update(chatMessages)
      .set({ isPinned: false, pinnedBy: null })
      .where(eq(chatMessages.id, messageId));

    await db
      .delete(pinnedMemories)
      .where(and(eq(pinnedMemories.sourceId, messageId), eq(pinnedMemories.sourceType, "chat")));
  }

  return NextResponse.json({ id: messageId, isPinned: nextPinned });
}
