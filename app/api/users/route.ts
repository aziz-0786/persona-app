import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, callSessions, memoriesLog, accounts, sessions, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { deleteKnowledgeNamespace, MEMORIES_INDEX_NAME } from "@/lib/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";

export async function DELETE() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  // Get all persona IDs for this user
  const userPersonas = await db
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.userId, userId));

  // Delete each persona's Pinecone namespaces
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  for (const { id: personaId } of userPersonas) {
    try { await deleteKnowledgeNamespace(personaId); } catch {}
    try {
      const { indexes } = await pc.listIndexes();
      if (indexes?.some((i) => i.name === MEMORIES_INDEX_NAME)) {
        await pc.index(MEMORIES_INDEX_NAME).namespace(personaId).deleteAll();
      }
    } catch {}
    await db.delete(memoriesLog).where(eq(memoriesLog.personaId, personaId));
    await db.delete(callSessions).where(eq(callSessions.personaId, personaId));
  }
  await db.delete(personas).where(eq(personas.userId, userId));

  // Delete auth tables and user row
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  // Then delete the user row itself
  await db.delete(users).where(eq(users.id, userId));

  return NextResponse.json({ deleted: true });
}
