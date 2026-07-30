"use client";
import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { useWarmupContext } from "@/components/WarmupManagerProvider";

// No sign-out control existed anywhere in the app before this — the only
// prior signOut() call was buried inside DeleteAccountButton as part of
// account deletion, not a standalone logout action.
export function SignOutButton() {
  const { destroy } = useWarmupContext();

  function handleSignOut() {
    destroy(); // stop pings immediately, before the session is gone
    signOut({ callbackUrl: "/login" });
  }

  return (
    <button
      onClick={handleSignOut}
      className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-error hover:bg-error/85 rounded-xl transition-colors shadow-sm"
    >
      <LogOut size={16} />
      Sign Out
    </button>
  );
}
