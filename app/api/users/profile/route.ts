import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/users/profile — current user's self-onboarding fields
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [user] = await db
    .select({ displayName: users.displayName, profileBio: users.profileBio })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(user);
}

// PATCH /api/users/profile — save displayName + profileBio
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { displayName, profileBio } = await req.json();

  if (typeof displayName !== "string" || !displayName.trim()) {
    return NextResponse.json({ error: "displayName is required" }, { status: 400 });
  }

  const [updated] = await db
    .update(users)
    .set({
      displayName: displayName.trim(),
      profileBio: typeof profileBio === "string" ? profileBio : null,
    })
    .where(eq(users.id, session.user.id))
    .returning({ displayName: users.displayName, profileBio: users.profileBio });

  return NextResponse.json(updated);
}
