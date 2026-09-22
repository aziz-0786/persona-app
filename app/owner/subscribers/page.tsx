import Link from "next/link";
import { db } from "@/db";
import { subscriptions, users, userCreditBalances } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { getPlanByPriceId } from "@/lib/stripe";

// Matches the actual values written by app/api/stripe/webhook/route.ts
// ("cancelled", double-l, per db/schema.ts's own enum comment) rather than
// the single-l American spelling — using "canceled" here would silently
// match zero rows.
// "cancelled" double-l is intentional — must match owner/admin queries;
// Stripe uses "canceled" (single-l) in its own API but we don't copy
// Stripe's status string directly here
const STATUSES = ["active", "cancelled", "past_due", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

const BADGE_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-700 border-green-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
  past_due: "bg-yellow-100 text-yellow-700 border-yellow-200",
  trialing: "bg-blue-100 text-blue-700 border-blue-200",
};

export default async function OwnerSubscribersPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const status: StatusFilter = STATUSES.includes(searchParams.status as StatusFilter)
    ? (searchParams.status as StatusFilter)
    : "all";

  const rows = await db
    .select({
      id: subscriptions.id,
      email: users.email,
      stripePriceId: subscriptions.stripePriceId,
      status: subscriptions.status,
      createdAt: subscriptions.createdAt,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      balance: userCreditBalances.balance,
      lifetimeCreditsUsed: userCreditBalances.lifetimeCreditsUsed,
    })
    .from(subscriptions)
    .leftJoin(users, eq(users.id, subscriptions.userId))
    .leftJoin(userCreditBalances, eq(userCreditBalances.userId, subscriptions.userId))
    .where(status === "all" ? undefined : eq(subscriptions.status, status))
    .orderBy(desc(subscriptions.createdAt));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Subscribers</h1>
        <div className="flex gap-1 border border-gray-200 rounded-md p-0.5">
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={`/owner/subscribers?status=${s}`}
              className={`px-3 py-1 text-sm rounded ${
                status === s ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {[
                "Email",
                "Plan",
                "Status",
                "Since",
                "Period End",
                "Credits Balance",
                "Lifetime Credits Used",
              ].map((h) => (
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
            {rows.map((row) => {
              const plan = getPlanByPriceId(row.stripePriceId);
              return (
                <tr key={row.id}>
                  <td className="px-4 py-2 text-gray-900">{row.email ?? "—"}</td>
                  <td className="px-4 py-2 text-gray-700">{plan?.label ?? "Unknown plan"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-0.5 text-xs font-medium rounded-full border ${
                        BADGE_STYLES[row.status] ?? "bg-gray-100 text-gray-700 border-gray-200"
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{row.createdAt.toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {row.currentPeriodEnd.toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{row.balance ?? 0}</td>
                  <td className="px-4 py-2 text-gray-700">{row.lifetimeCreditsUsed ?? 0}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                  No subscribers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
