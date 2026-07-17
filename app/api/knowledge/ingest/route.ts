import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { chunkText } from "@/lib/chunk";
import { upsertKnowledgeChunks } from "@/lib/pinecone";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/knowledge/ingest — chunk text and upsert into the persona's
// Pinecone namespace using integrated inference (no separate embedding call)
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { personaId, text, source = "paste" } = await req.json();

  if (!personaId || !text || typeof text !== "string") {
    return NextResponse.json({ error: "Missing personaId or text" }, { status: 400 });
  }

  const [persona] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const chunks = chunkText(text);

  if (chunks.length === 0) {
    return NextResponse.json({ error: "No text content to ingest" }, { status: 400 });
  }

  if (!process.env.PINECONE_API_KEY) {
    // Stub for local dev without Pinecone configured yet
    return NextResponse.json({ chunkCount: chunks.length, stub: true });
  }

  try {
    await upsertKnowledgeChunks(
      personaId,
      chunks.map((chunk) => ({ id: randomUUID(), text: chunk, source }))
    );
  } catch (err) {
    console.error("Pinecone ingest error:", err);
    return NextResponse.json({ error: "Failed to ingest knowledge" }, { status: 502 });
  }

  return NextResponse.json({ chunkCount: chunks.length });
}
