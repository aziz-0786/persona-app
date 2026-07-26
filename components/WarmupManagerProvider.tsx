"use client";
import { createContext, useContext, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useWarmupManager } from "@/hooks/useWarmupManager";

type WarmupContextValue = ReturnType<typeof useWarmupManager>;

const WarmupContext = createContext<WarmupContextValue | null>(null);

// Single shared manager instance for the whole app (mounted once in
// app/layout.tsx) — the sign-out button needs to call destroy() on the SAME
// interval this provider is running, not a second independent one that a
// standalone useWarmupManager() call elsewhere would create.
export function WarmupManagerProvider({ children }: { children: React.ReactNode }) {
  const manager = useWarmupManager();
  const pathname = usePathname();

  useEffect(() => {
    const inCallOrChat = pathname?.startsWith("/call/") || pathname?.startsWith("/chat/");
    if (inCallOrChat) {
      manager.pause();
    } else {
      manager.resume();
    }
    // manager's functions are stable (useCallback), only pathname should
    // re-trigger this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return <WarmupContext.Provider value={manager}>{children}</WarmupContext.Provider>;
}

export function useWarmupContext(): WarmupContextValue {
  const ctx = useContext(WarmupContext);
  if (!ctx) {
    throw new Error("useWarmupContext must be used within WarmupManagerProvider");
  }
  return ctx;
}
