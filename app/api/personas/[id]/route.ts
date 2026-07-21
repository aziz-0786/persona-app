import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, callSessions, memoriesLog } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { deleteKnowledgeNamespace } from "@/lib/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { MEMORIES_INDEX_NAME } from "@/lib/pinecone";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const personaId = params.id;

  // Ownership check
  const [persona] = await db
    .select({ userId: personas.userId })
    .from(personas)
    .where(eq(personas.id, personaId))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (persona.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Delete Pinecone namespaces (best effort — don't crash if index missing)
  try {
    await deleteKnowledgeNamespace(personaId);
  } catch (e) {
    console.warn("[DELETE PERSONA] knowledge namespace cleanup failed:", e);
  }
  try {
    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    const { indexes } = await pc.listIndexes();
    if (indexes?.some((i) => i.name === MEMORIES_INDEX_NAME)) {
      await pc.index(MEMORIES_INDEX_NAME).namespace(personaId).deleteAll();
    }
  } catch (e) {
    console.warn("[DELETE PERSONA] memories namespace cleanup failed:", e);
  }

  // Delete DB rows in FK-safe order
  await db.delete(memoriesLog).where(eq(memoriesLog.personaId, personaId));
  await db.delete(callSessions).where(eq(callSessions.personaId, personaId));
  await db.delete(personas).where(eq(personas.id, personaId));

  return NextResponse.json({ deleted: true });
}
