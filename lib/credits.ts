import { db } from "@/db";
import { creditTransactions, userCreditBalances } from "@/db/schema";
import { and, eq } from "drizzle-orm";

type CreditTransactionType =
  | "signup_bonus"
  | "subscription_refresh"
  | "topup"
  | "call_usage"
  | "refund"
  | "admin_grant"
  | "admin_deduction";

// Adds credits and appends the append-only ledger row in one call. Balance
// on user_credit_balances is a read cache — creditTransactions is the
// source of truth (see db/schema.ts comment on the Credits & Billing tables).
export async function addCredits(
  userId: string,
  credits: number,
  type: CreditTransactionType,
  stripePaymentIntentId?: string
) {
  const [existing] = await db
    .select()
    .from(userCreditBalances)
    .where(eq(userCreditBalances.userId, userId))
    .limit(1);

  const currentBalance = existing?.balance ?? 0;
  const newBalance = currentBalance + credits;

  await db.insert(creditTransactions).values({
    userId,
    type,
    credits,
    balanceAfter: newBalance,
    stripePaymentIntentId,
  });

  if (existing) {
    await db
      .update(userCreditBalances)
      .set({ balance: newBalance, updatedAt: new Date() })
      .where(eq(userCreditBalances.userId, userId));
  } else {
    await db.insert(userCreditBalances).values({ userId, balance: newBalance });
  }

  return newBalance;
}

export async function deductCredits(
  userId: string,
  credits: number,
  type: CreditTransactionType = "call_usage",
  callId?: string
) {
  const [existing] = await db
    .select()
    .from(userCreditBalances)
    .where(eq(userCreditBalances.userId, userId))
    .limit(1);

  const currentBalance = existing?.balance ?? 0;
  if (currentBalance < credits) throw new Error("Insufficient credits");

  const newBalance = currentBalance - credits;

  await db.insert(creditTransactions).values({
    userId,
    type,
    credits: -credits,
    balanceAfter: newBalance,
    callId,
  });

  await db
    .update(userCreditBalances)
    .set({
      balance: newBalance,
      lifetimeCreditsUsed: (existing?.lifetimeCreditsUsed ?? 0) + credits,
      updatedAt: new Date(),
    })
    .where(eq(userCreditBalances.userId, userId));

  return newBalance;
}

export async function getBalance(userId: string) {
  const [existing] = await db
    .select({ balance: userCreditBalances.balance })
    .from(userCreditBalances)
    .where(eq(userCreditBalances.userId, userId))
    .limit(1);

  return existing?.balance ?? 0;
}

// Idempotent — only grants the one-time signup bonus if it hasn't already
// been recorded for this user (called from lib/auth.ts's createUser event,
// which itself only fires once per account, but this guards against retries).
export async function grantSignupCredits(userId: string) {
  const [existing] = await db
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(
      and(eq(creditTransactions.userId, userId), eq(creditTransactions.type, "signup_bonus"))
    )
    .limit(1);

  if (existing) return;

  await addCredits(userId, 300, "signup_bonus");
}
