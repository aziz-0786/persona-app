import Link from "next/link";
import { db } from "@/db";
import { users, userCreditBalances, subscriptions } from "@/db/schema";
import { and, desc, eq, ilike } from "drizzle-orm";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = searchParams.q?.trim();

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      balance: userCreditBalances.balance,
      subStatus: subscriptions.status,
      stripePriceId: subscriptions.stripePriceId,
    })
    .from(users)
    .leftJoin(userCreditBalances, eq(userCreditBalances.userId, users.id))
    .leftJoin(
      subscriptions,
      and(eq(subscriptions.userId, users.id), eq(subscriptions.status, "active"))
    )
    .where(q ? ilike(users.email, `%${q}%`) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(100);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Users</h1>
        <form className="flex gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search by email..."
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900"
          />
          <button
            type="submit"
            className="px-3 py-1.5 text-sm font-medium bg-gray-900 text-white rounded-md"
          >
            Search
          </button>
        </form>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Name", "Email", "Role", "Balance (credits)", "Plan", "Joined", "Actions"].map(
                (h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wide text-xs"
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-2 text-gray-900">{row.name ?? "—"}</td>
                <td className="px-4 py-2 text-gray-900">{row.email}</td>
                <td className="px-4 py-2 text-gray-700">{row.role}</td>
                <td className="px-4 py-2 text-gray-700">{row.balance ?? 0}</td>
                <td className="px-4 py-2 text-gray-700">{row.subStatus ? row.stripePriceId : "Free"}</td>
                <td className="px-4 py-2 text-gray-500">
                  {row.createdAt.toLocaleDateString()}
                </td>
                <td className="px-4 py-2">
                  <Link href={`/admin/users/${row.id}`} className="text-blue-600 hover:underline">
                    View
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
