"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { usePersona } from "@/lib/hooks";
import { PhoneCall, MessageCircle, Trash2, ArrowLeft } from "lucide-react";

export default function PersonaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { persona, loading } = usePersona(id);
  const [deleting, setDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/personas/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      router.push("/");
    } catch (e) {
      console.error(e);
      setDeleting(false);
      setShowConfirm(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (!persona) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-text-secondary">Persona not found.</div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-void p-6 max-w-xl mx-auto">
      <button
        onClick={() => router.push("/")}
        className="flex items-center gap-2 text-text-secondary hover:text-text-primary mb-6 text-sm"
      >
        <ArrowLeft size={16} /> Back
      </button>

      <div className="flex items-center gap-4 mb-8">
        <div className="w-14 h-14 rounded-full bg-accent/20 flex items-center justify-center text-2xl font-bold text-accent">
          {persona.name?.[0] ?? "?"}
        </div>
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{persona.name}</h1>
          <p className="text-text-secondary text-sm capitalize">
            {persona.relationship}
          </p>
        </div>
      </div>

      <div className="flex gap-3 mb-10">
        <button
          onClick={() => router.push(`/call/${id}`)}
          className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/90 text-white py-3 rounded-xl font-medium transition-colors"
        >
          <PhoneCall size={18} /> Call
        </button>
        <button
          onClick={() => router.push(`/chat/${id}`)}
          className="flex-1 flex items-center justify-center gap-2 bg-surface hover:bg-surface/80 text-text-primary py-3 rounded-xl font-medium transition-colors"
        >
          <MessageCircle size={18} /> Chat
        </button>
      </div>

      {/* Danger Zone */}
      <div className="border border-red-900/40 rounded-xl p-5 bg-red-950/10">
        <h2 className="text-red-400 font-semibold mb-1">Danger Zone</h2>
        <p className="text-text-secondary text-sm mb-4">
          Permanently delete {persona.name} and all their memories. This
          cannot be undone.
        </p>
        {!showConfirm ? (
          <button
            onClick={() => setShowConfirm(true)}
            className="flex items-center gap-2 text-red-400 hover:text-red-300 text-sm font-medium transition-colors"
          >
            <Trash2 size={15} /> Delete Persona
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-red-300 text-sm font-medium">
              Are you sure? This will permanently delete {persona.name} and
              all their memories.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {deleting ? "Deleting..." : "Yes, delete permanently"}
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="text-text-secondary hover:text-text-primary px-4 py-2 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
