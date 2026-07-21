import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

// GET /api/users/me — id + self-onboarding fields for the current session user
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [user] = await db
    .select({ id: users.id, displayName: users.displayName, profileBio: users.profileBio })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(user);
}
