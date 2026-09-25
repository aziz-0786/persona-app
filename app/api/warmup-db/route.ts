import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { warmupLimiter } from '@/lib/ratelimit';

// No auth — this is a pre-warm/health ping, not a user action. Rate-limited
// by IP instead, since there's no session to key on.
export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const { success } = await warmupLimiter.limit(ip);
  if (!success) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }

  await db.execute(sql`SELECT 1`);
  return NextResponse.json({ ok: true });
}
