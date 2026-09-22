import Link from "next/link";
import { db } from "@/db";
import { subscriptions, creditTransactions } from "@/db/schema";
import { and, count, eq, gte } from "drizzle-orm";
import { CREDIT_BUNDLES, getPlanByPriceId } from "@/lib/stripe";

const PERIODS = { "30d": 30, "90d": 90, all: null } as const;
type Period = keyof typeof PERIODS;

const AVG_BUNDLE_PRICE =
  CREDIT_BUNDLES.reduce((sum, b) => sum + b.price, 0) / CREDIT_BUNDLES.length;

function cutoffFor(period: Period) {
  const days = PERIODS[period];
  if (days === null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export default async function OwnerRevenuePage({
  searchParams,
}: {
  searchParams: { period?: string };
}) {
  const period: Period = searchParams.period === "90d" || searchParams.period === "all"
    ? searchParams.period
    : "30d";
  const cutoff = cutoffFor(period);

  const [[topups], subsByPrice, [newSubs], [churnedSubs]] = await Promise.all([
    db
      .select({ value: count() })
      .from(creditTransactions)
      .where(
        cutoff
          ? and(eq(creditTransactions.type, "topup"), gte(creditTransactions.createdAt, cutoff))
          : eq(creditTransactions.type, "topup")
      ),
    db
      .select({ stripePriceId: subscriptions.stripePriceId, value: count() })
      .from(subscriptions)
      .where(eq(subscriptions.status, "active"))
      .groupBy(subscriptions.stripePriceId),
    db
      .select({ value: count() })
      .from(subscriptions)
      .where(cutoff ? gte(subscriptions.createdAt, cutoff) : undefined),
    db
      .select({ value: count() })
      .from(subscriptions)
      // "cancelled" double-l is intentional — must match owner/admin
      // queries; Stripe uses "canceled" (single-l) in its own API but we
      // don't copy Stripe's status string directly here
      .where(
        cutoff
          ? and(eq(subscriptions.status, "cancelled"), gte(subscriptions.updatedAt, cutoff))
          : eq(subscriptions.status, "cancelled")
      ),
  ]);

  const netNew = newSubs.value - churnedSubs.value;
  const estimatedTopupRevenue = topups.value * AVG_BUNDLE_PRICE;

  const planRows = subsByPrice.map((row) => {
    const plan = getPlanByPriceId(row.stripePriceId);
    return {
      priceId: row.stripePriceId,
      label: plan?.label ?? "Unknown plan",
      count: row.value,
      monthlyValue: plan?.price ?? 0,
      mrrContribution: (plan?.price ?? 0) * row.value,
    };
  });

  const tabs: { key: Period; label: string }[] = [
    { key: "30d", label: "30d" },
    { key: "90d", label: "90d" },
    { key: "all", label: "All time" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Revenue</h1>
        <div className="flex gap-1 border border-gray-200 rounded-md p-0.5">
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              href={`/owner/revenue?period=${tab.key}`}
              className={`px-3 py-1 text-sm rounded ${
                period === tab.key
                  ? "bg-gray-900 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Subscriber Breakdown
        </h2>
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["Plan", "Count", "Monthly Value", "Total MRR Contribution"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wide text-xs"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {planRows.map((row) => (
                <tr key={row.priceId ?? "none"}>
                  <td className="px-4 py-2 text-gray-900">{row.label}</td>
                  <td className="px-4 py-2 text-gray-700">{row.count}</td>
                  <td className="px-4 py-2 text-gray-700">${row.monthlyValue}</td>
                  <td className="px-4 py-2 text-gray-700">${row.mrrContribution.toLocaleString()}</td>
                </tr>
              ))}
              {planRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                    No active subscribers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Net Subscriber Movement ({period === "all" ? "all time" : period})
        </h2>
        <div className="border border-gray-200 rounded-lg p-4 flex gap-8 text-sm">
          <span className="text-green-600 font-medium">+{newSubs.value} new</span>
          <span className="text-red-600 font-medium">-{churnedSubs.value} churned</span>
          <span className="text-gray-900 font-medium">={netNew} net</span>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Credit Top-ups
        </h2>
        <div className="border border-gray-200 rounded-lg p-4 text-sm text-gray-700">
          Top-up transactions: {topups.value} (revenue: est. ${estimatedTopupRevenue.toLocaleString()})
          <p className="text-xs text-gray-400 mt-1">
            Estimated as transaction count × average bundle price (${AVG_BUNDLE_PRICE.toFixed(2)}).
            Exact figures require pulling amounts from Stripe directly.
          </p>
        </div>
      </section>
    </div>
  );
}
