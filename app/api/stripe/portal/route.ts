import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripeClient, getAppUrl } from "@/lib/stripe";
import { db } from "@/db";
import { subscriptions } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const runtime = "nodejs";

// POST /api/stripe/portal — creates a Stripe Billing Portal session so the
// user can manage or cancel their subscription.
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const stripe = getStripeClient();

  const [existingSub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, session.user.id))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!existingSub) {
    return NextResponse.json({ error: "No subscription found" }, { status: 404 });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: existingSub.stripeCustomerId,
    return_url: `${getAppUrl()}/dashboard/subscription`,
  });

  return NextResponse.json({ url: portalSession.url });
}
