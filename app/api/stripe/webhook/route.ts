import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripeClient, PLANS } from "@/lib/stripe";
import { db } from "@/db";
import { subscriptions, processedStripeEvents } from "@/db/schema";
import { addCredits } from "@/lib/credits";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

// POST /api/stripe/webhook — public, no auth (Stripe signs the payload
// instead). Deliberately not wired to callLimiter/apiLimiter (see
// claude/handover-sep-2026.md gotchas) — Stripe's retried deliveries must
// never collide with per-user rate limits.
export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const stripe = getStripeClient();

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", (err as Error).message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const [alreadyProcessed] = await db
    .select({ id: processedStripeEvents.id })
    .from(processedStripeEvents)
    .where(eq(processedStripeEvents.id, event.id))
    .limit(1);
  if (alreadyProcessed) return NextResponse.json({ received: true });

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) break;

      if (session.mode === "subscription" && session.subscription) {
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const item = sub.items.data[0];

        await db.insert(subscriptions).values({
          userId,
          stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          stripeSubscriptionId: sub.id,
          stripePriceId: item.price.id,
          status: sub.status,
          currentPeriodStart: new Date(item.current_period_start * 1000),
          currentPeriodEnd: new Date(item.current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        });
      } else if (session.mode === "payment") {
        const credits = parseInt(session.metadata?.credits ?? "0", 10);
        if (credits > 0) {
          const paymentIntentId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id;
          await addCredits(userId, credits, "topup", paymentIntentId);
        }
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionRef = invoice.parent?.subscription_details?.subscription;
      if (!subscriptionRef) break;
      const subscriptionId =
        typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef.id;

      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const item = sub.items.data[0];

      const [existing] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
        .limit(1);
      if (!existing) break;

      await db
        .update(subscriptions)
        .set({
          status: "active",
          stripePriceId: item.price.id,
          currentPeriodStart: new Date(item.current_period_start * 1000),
          currentPeriodEnd: new Date(item.current_period_end * 1000),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));

      const plan = Object.values(PLANS).find(
        (p): p is (typeof PLANS)["STARTER"] | (typeof PLANS)["PRO"] =>
          "priceId" in p && p.priceId === item.price.id
      );
      if (plan) await addCredits(existing.userId, plan.credits, "subscription_refresh");
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionRef = invoice.parent?.subscription_details?.subscription;
      if (!subscriptionRef) break;
      const subscriptionId =
        typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef.id;

      await db
        .update(subscriptions)
        .set({ status: "past_due", updatedAt: new Date() })
        .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      // Credits already granted this period are not clawed back.
      await db
        .update(subscriptions)
        // "cancelled" double-l is intentional — must match owner/admin
        // queries; Stripe uses "canceled" (single-l) in its own API but we
        // don't copy Stripe's status string directly here
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(subscriptions.stripeSubscriptionId, sub.id));
      break;
    }

    default:
      break;
  }

  await db.insert(processedStripeEvents).values({ id: event.id, type: event.type });

  return NextResponse.json({ received: true });
}
