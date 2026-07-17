"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Users, Settings, Plus } from "lucide-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const nav = [
    { href: "/", label: "Personas", icon: Users },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  const isFullscreen = pathname?.startsWith("/call/");

  if (isFullscreen) return <>{children}</>;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top nav */}
      <header className="sticky top-0 z-50 border-b border-border bg-void/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center shadow-glow">
              <span className="text-white text-xs font-bold">P</span>
            </div>
            <span className="font-display font-semibold text-text-primary group-hover:text-warm transition-colors">
              Persona
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  pathname === href
                    ? "bg-elevated text-text-primary"
                    : "text-text-secondary hover:text-text-primary hover:bg-elevated/50"
                )}
              >
                <Icon size={15} />
                {label}
              </Link>
            ))}
            <Link
              href="/onboard"
              className="ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-accent hover:bg-accent-hover text-white transition-colors shadow-glow"
            >
              <Plus size={15} />
              New
            </Link>
          </nav>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
        {children}
      </main>
    </div>
  );
}
