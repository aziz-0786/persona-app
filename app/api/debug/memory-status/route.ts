import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getMemoryIndexStats } from "@/lib/pinecone";

export const runtime = "nodejs";

// Debug-only: which personas have memories in the shared persona-memories
// Pinecone index, and how many vectors each has (namespace = personaId).
// Gated behind auth, same as every other route in this app — the original
// spec for this endpoint had no auth check at all, but it enumerates
// persona UUIDs and memory presence, not something to leave open.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.PINECONE_API_KEY) {
    return NextResponse.json({ error: "Pinecone not configured" }, { status: 500 });
  }

  const stats = await getMemoryIndexStats();
  return NextResponse.json(stats);
}
