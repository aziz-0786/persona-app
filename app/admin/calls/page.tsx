import Link from "next/link";
import { db } from "@/db";
import { calls, users } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminCallsPage({
  searchParams,
}: {
  searchParams: { userId?: string; status?: string; page?: string };
}) {
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const userId = searchParams.userId && UUID_RE.test(searchParams.userId) ? searchParams.userId : undefined;
  const status = searchParams.status;

  const conditions = [
    userId ? eq(calls.userId, userId) : undefined,
    status ? eq(calls.status, status) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select({
      id: calls.id,
      startedAt: calls.startedAt,
      durationSeconds: calls.durationSeconds,
      creditsUsed: calls.creditsUsed,
      platform: calls.platform,
      status: calls.status,
      userEmail: users.email,
    })
    .from(calls)
    .leftJoin(users, eq(users.id, calls.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(calls.startedAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  function pageHref(targetPage: number) {
    const params = new URLSearchParams();
    if (userId) params.set("userId", userId);
    if (status) params.set("status", status);
    params.set("page", String(targetPage));
    return `/admin/calls?${params.toString()}`;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Calls</h1>

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {["Started At", "User Email", "Duration", "Credits Used", "Platform", "Status"].map(
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
                <td className="px-4 py-2 text-gray-500">{row.startedAt.toLocaleString()}</td>
                <td className="px-4 py-2 text-gray-900">{row.userEmail ?? "—"}</td>
                <td className="px-4 py-2 text-gray-700">
                  {row.durationSeconds != null ? `${row.durationSeconds}s` : "—"}
                </td>
                <td className="px-4 py-2 text-gray-700">{row.creditsUsed}</td>
                <td className="px-4 py-2 text-gray-700">{row.platform}</td>
                <td className="px-4 py-2 text-gray-700">{row.status}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                  No calls found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        {page > 1 ? (
          <Link href={pageHref(page - 1)} className="text-blue-600 hover:underline">
            ← Previous
          </Link>
        ) : (
          <span />
        )}
        <span className="text-gray-500">Page {page}</span>
        {rows.length === PAGE_SIZE ? (
          <Link href={pageHref(page + 1)} className="text-blue-600 hover:underline">
            Next →
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
