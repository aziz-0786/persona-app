import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/personas?id=<uuid>  — single persona
// GET /api/personas             — list all for user
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");

  if (id) {
    const [persona] = await db
      .select()
      .from(personas)
      .where(and(eq(personas.id, id), eq(personas.userId, session.user.id)))
      .limit(1);
    if (!persona) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(persona);
  }

  const all = await db.select().from(personas).where(eq(personas.userId, session.user.id));
  return NextResponse.json(all);
}

// POST /api/personas — create
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();

  // Handle consent-first creation from /onboard
  if (body.action === "create_with_consent") {
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New Persona";
    const [persona] = await db
      .insert(personas)
      .values({
        userId: session.user.id,
        name,
        relationship: body.relationship ?? null,
        consentVersion: body.consentVersion ?? "1.0",
        consentScopeJson: body.consentScopeJson,
        consentSignedAt: new Date(),
        consentAudioB64: body.consentAudioB64 ?? null,
      })
      .returning();
    return NextResponse.json({ personaId: persona.id });
  }

  // Full create/update
  const {
    name,
    relationship,
    bioJson,
    characterCardText,
    voiceRefB64,
    voiceParamsJson,
    avatarUrl,
    avatarType,
  } = body;

  const [persona] = await db
    .insert(personas)
    .values({
      userId: session.user.id,
      name,
      relationship,
      bioJson,
      characterCardText,
      voiceRefB64,
      voiceParamsJson,
      avatarUrl,
      avatarType,
    })
    .returning();

  return NextResponse.json(persona);
}

// PATCH /api/personas — update
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const [persona] = await db
    .update(personas)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(personas.id, id), eq(personas.userId, session.user.id)))
    .returning();

  if (!persona) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(persona);
}

// DELETE /api/personas?id=<uuid> — purge persona + trigger Pinecone namespace delete
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Verify ownership before delete
  const [existing] = await db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase 7: delete Pinecone namespace here
  // await pinecone.index("persona-memories").deleteAll({ namespace: id });

  await db
    .delete(personas)
    .where(and(eq(personas.id, id), eq(personas.userId, session.user.id)));

  return NextResponse.json({ deleted: true });
}
