"use client";
import { useState } from "react";
import { signOut } from "next-auth/react";

export function DeleteAccountButton() {
  const [deleting, setDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch("/api/users", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete account");
      await signOut({ callbackUrl: "/login" });
    } catch (e) {
      console.error(e);
      setDeleting(false);
      setShowConfirm(false);
    }
  }

  if (!showConfirm) {
    return (
      <button
        onClick={() => setShowConfirm(true)}
        className="px-4 py-2 text-sm font-medium text-error bg-error/10 hover:bg-error/20 border border-error/30 rounded-xl transition-colors"
      >
        Delete account and all data
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-error">
        This will permanently delete your account and all personas. This
        cannot be undone.
      </p>
      <div className="flex gap-3">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="px-4 py-2 text-sm font-medium text-white bg-error hover:bg-error/90 disabled:opacity-50 rounded-xl transition-colors"
        >
          {deleting ? "Deleting..." : "Yes, delete permanently"}
        </button>
        <button
          onClick={() => setShowConfirm(false)}
          className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-xl transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
