import { db } from "@/db";
import { users, subscriptions, calls, userCreditBalances } from "@/db/schema";
import { count, eq, gte, sum } from "drizzle-orm";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-gray-200 rounded-lg p-5 bg-white">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-3xl font-semibold text-gray-900 mt-1">{value}</p>
    </div>
  );
}

export default async function AdminDashboardPage() {
  const todayMidnightUtc = new Date();
  todayMidnightUtc.setUTCHours(0, 0, 0, 0);

  const [[totalUsers], [activeSubs], [callsToday], [creditsInCirculation]] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(subscriptions).where(eq(subscriptions.status, "active")),
    db.select({ value: count() }).from(calls).where(gte(calls.startedAt, todayMidnightUtc)),
    db.select({ value: sum(userCreditBalances.balance) }).from(userCreditBalances),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label="Total Users" value={totalUsers.value} />
        <StatCard label="Active Subscribers" value={activeSubs.value} />
        <StatCard label="Calls Today" value={callsToday.value} />
        <StatCard
          label="Total Credits in Circulation"
          value={Number(creditsInCirculation.value ?? 0).toLocaleString()}
        />
      </div>
    </div>
  );
}
