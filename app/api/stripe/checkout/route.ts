import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripeClient, getAppUrl } from "@/lib/stripe";
import { db } from "@/db";
import { subscriptions } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const runtime = "nodejs";

// POST /api/stripe/checkout — creates a Stripe Checkout session for either
// a subscription plan or a one-time credit top-up.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const stripe = getStripeClient();

  const { type, priceId, credits } = (await req.json()) as {
    type: "subscription" | "topup";
    priceId: string;
    credits?: number;
  };

  if (type !== "subscription" && type !== "topup") {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
  if (!priceId) {
    return NextResponse.json({ error: "Missing priceId" }, { status: 400 });
  }

  // Reuse an existing Stripe customer for this user if one is on file,
  // otherwise search by email, otherwise create one.
  const [existingSub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, session.user.id))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  let customerId = existingSub?.stripeCustomerId;

  if (!customerId) {
    const found = await stripe.customers.search({
      query: `email:"${session.user.email}"`,
    });
    customerId = found.data[0]?.id;
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: session.user.email,
      metadata: { userId: session.user.id },
    });
    customerId = customer.id;
  }

  const appUrl = getAppUrl();

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: type === "subscription" ? "subscription" : "payment",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/dashboard/credits?success=1`,
    cancel_url: `${appUrl}/dashboard/credits`,
    metadata: {
      userId: session.user.id,
      credits: credits?.toString() ?? "",
    },
  });

  return NextResponse.json({ url: checkoutSession.url });
}
