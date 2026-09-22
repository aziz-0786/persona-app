import { notFound } from "next/navigation";
import { db } from "@/db";
import { users, userCreditBalances, creditTransactions, calls, subscriptions } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { CreditAdjustForm } from "./CreditAdjustForm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminUserDetailPage({ params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) notFound();

  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, params.id))
    .limit(1);

  if (!user) notFound();

  const [balanceRow, transactions, callHistory, [activeSub]] = await Promise.all([
    db
      .select({ balance: userCreditBalances.balance })
      .from(userCreditBalances)
      .where(eq(userCreditBalances.userId, params.id))
      .limit(1),
    db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, params.id))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(20),
    db
      .select()
      .from(calls)
      .where(eq(calls.userId, params.id))
      .orderBy(desc(calls.startedAt))
      .limit(20),
    db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, params.id), eq(subscriptions.status, "active")))
      .limit(1),
  ]);

  const balance = balanceRow[0]?.balance ?? 0;

  return (
    <div className="space-y-8">
      {/* User header */}
      <div className="flex items-start justify-between border-b border-gray-200 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900">{user.name ?? user.email}</h1>
            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200">
              {user.role}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{user.email}</p>
          <p className="text-xs text-gray-400 mt-1">
            Member since {user.createdAt.toLocaleDateString()}
          </p>
          {activeSub && (
            <p className="text-xs text-gray-500 mt-1">
              Active subscription: {activeSub.stripePriceId} (renews{" "}
              {activeSub.currentPeriodEnd.toLocaleDateString()})
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-500">Credit balance</p>
          <p className="text-3xl font-semibold text-gray-900">{balance.toLocaleString()}</p>
        </div>
      </div>

      {/* Manual credit adjustment */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Manual Credit Adjustment
        </h2>
        <CreditAdjustForm userId={user.id} />
      </section>

      {/* Transaction history */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Transaction History
        </h2>
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["Date", "Type", "Credits", "Balance After", "Description"].map((h) => (
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
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td className="px-4 py-2 text-gray-500">{tx.createdAt.toLocaleString()}</td>
                  <td className="px-4 py-2 text-gray-700">{tx.type}</td>
                  <td className={`px-4 py-2 ${tx.credits < 0 ? "text-red-600" : "text-green-600"}`}>
                    {tx.credits > 0 ? "+" : ""}
                    {tx.credits}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{tx.balanceAfter}</td>
                  <td className="px-4 py-2 text-gray-500">{tx.description ?? "—"}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                    No transactions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Call history */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
          Call History
        </h2>
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["Date", "Persona", "Duration", "Credits Used", "Status"].map((h) => (
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
              {callHistory.map((call) => (
                <tr key={call.id}>
                  <td className="px-4 py-2 text-gray-500">{call.startedAt.toLocaleString()}</td>
                  <td className="px-4 py-2 text-gray-700">{call.personaId ?? "—"}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {call.durationSeconds != null ? `${call.durationSeconds}s` : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{call.creditsUsed}</td>
                  <td className="px-4 py-2 text-gray-700">{call.status}</td>
                </tr>
              ))}
              {callHistory.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                    No calls yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
