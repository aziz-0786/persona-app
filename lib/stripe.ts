import Stripe from "stripe";

// Lazy — constructing Stripe at module load time meant importing ANYTHING
// from this file (even just PLANS/getPlanByPriceId, which the dashboard and
// owner pages do) threw at Next.js build time whenever STRIPE_SECRET_KEY is
// unset, since the whole module executes on first import regardless of
// which export is used. Deferring construction until a route actually needs
// the client keeps every other export in this file safe to import even
// with no Stripe key configured.
let _stripeInstance: Stripe | null = null;
export function getStripeClient(): Stripe {
  if (!_stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    _stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20" as Stripe.LatestApiVersion,
    });
  }
  return _stripeInstance;
}

// Base URL for Stripe redirect targets. This repo's .env.example uses
// NEXT_PUBLIC_APP_URL (NEXTAUTH_URL is unused elsewhere in the codebase).
export function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

// Price IDs are empty until the Stripe products are created in the
// dashboard at launch (see claude/production-architecture.md, Phase 5).
export const PLANS = {
  FREE: { credits: 300 },
  STARTER: { priceId: "", credits: 3000, price: 9 },
  PRO: { priceId: "", credits: 15000, price: 29 },
  BUSINESS: { priceId: "", credits: 60000, price: 99 },
} as const;

export const CREDIT_BUNDLES = [
  { id: "bundle_1000", credits: 1000, price: 2, priceId: "" },
  { id: "bundle_5000", credits: 5000, price: 8, priceId: "" },
] as const;

// Flat list form of the paid PLANS entries, for owner-portal reporting that
// needs to map a subscription's stripePriceId back to a plan name/price.
export const PAID_PLANS = [
  { key: "starter", label: "Starter", priceId: PLANS.STARTER.priceId, credits: PLANS.STARTER.credits, price: PLANS.STARTER.price },
  { key: "pro", label: "Pro", priceId: PLANS.PRO.priceId, credits: PLANS.PRO.credits, price: PLANS.PRO.price },
  { key: "business", label: "Business", priceId: PLANS.BUSINESS.priceId, credits: PLANS.BUSINESS.credits, price: PLANS.BUSINESS.price },
] as const;

// All PAID_PLANS.priceId are "" until Basit sets real Stripe price IDs at
// launch — the `priceId !== ""` guard stops every subscription row from
// falsely matching the first plan once that's the only entry with priceId "".
export function getPlanByPriceId(priceId: string | null | undefined) {
  if (!priceId) return null;
  return PAID_PLANS.find((p) => p.priceId !== "" && p.priceId === priceId) ?? null;
}
