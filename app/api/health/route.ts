import { NextResponse } from "next/server";

// Dedicated health check target for Railway — "/" redirects unauthenticated
// requests to /login (307), and Railway's health check requires exactly 200
// with no redirect-following. This route never touches auth or the DB, so it
// can't fail for reasons unrelated to "is the server up."
export async function GET() {
  return NextResponse.json({ ok: true });
}
