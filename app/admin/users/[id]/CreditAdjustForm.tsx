"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function CreditAdjustForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount === 0) {
      setError("Amount must be a non-zero number");
      return;
    }
    if (!reason.trim()) {
      setError("Reason is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/credits/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, amount: parsedAmount, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Adjustment failed");

      setAmount("");
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Amount (positive = add, negative = deduct)
        </label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900"
          placeholder="e.g. 500 or -500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm text-gray-900"
          placeholder="Required — shown in the audit log"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 text-sm font-medium bg-gray-900 text-white rounded-md disabled:opacity-50"
      >
        {submitting ? "Applying..." : "Apply Adjustment"}
      </button>
    </form>
  );
}
