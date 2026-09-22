import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

// Middleware already redirects non-admins away from /admin/* using the JWT's
// role claim (edge-safe, no DB call). This is the defense-in-depth check
// against the live DB-backed session — see middleware.ts for why the split.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user || (session.user.role !== "admin" && session.user.role !== "owner")) {
    redirect("/");
  }

  const nav = [
    { href: "/admin/users", label: "Users" },
    { href: "/admin/calls", label: "Calls" },
    { href: "/admin/credits", label: "Credit Adjustments" },
  ];

  return (
    <div className="min-h-screen flex bg-gray-900">
      <aside className="w-56 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-gray-800">
          <span className="text-white font-semibold">Admin Panel</span>
        </div>
        <nav className="flex-1 py-4">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center justify-between px-6 border-b border-gray-200 bg-white">
          <span className="font-semibold text-gray-900">Admin Panel</span>
          <span className="text-sm text-gray-500">{session.user.email}</span>
        </header>
        <main className="flex-1 bg-white p-6">{children}</main>
      </div>
    </div>
  );
}
