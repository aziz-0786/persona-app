"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea } from "@/components/ui";
import { UserCircle } from "lucide-react";

export default function UserSetupPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/users/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.displayName) setDisplayName(data.displayName);
        if (data?.profileBio) setProfileBio(data.profileBio);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    if (!displayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/users/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim(), profileBio }),
      });
      if (!res.ok) throw new Error("Failed to save");
      router.push("/");
      router.refresh();
    } catch {
      setError("Couldn't save your profile. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-void flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shadow-glow">
            <span className="text-white text-sm font-bold">P</span>
          </div>
          <span className="font-display font-semibold text-text-primary">Persona</span>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <UserCircle size={20} className="text-accent" />
            </div>
            <div>
              <h1 className="font-display font-semibold text-text-primary">Tell us about you</h1>
              <p className="text-xs text-text-muted">
                Personas you talk to will know this — it makes conversations feel natural
              </p>
            </div>
          </div>

          {loading ? (
            <div className="py-8 text-center text-sm text-text-muted">Loading…</div>
          ) : (
            <div className="space-y-4">
              <Input
                label="What should we call you?"
                placeholder="e.g. Aziz"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
              />

              <div className="space-y-2">
                <Textarea
                  label="About you"
                  placeholder="A few sentences about yourself — your work, interests, how you like to communicate. Personas will use this to talk to you naturally."
                  value={profileBio}
                  onChange={(e) => setProfileBio(e.target.value)}
                  rows={5}
                />
                <p className="text-xs text-text-muted">
                  e.g. &quot;I&apos;m a startup founder in Bengaluru. I like direct conversations,
                  dark humor, and hate small talk.&quot;
                </p>
              </div>

              {error && <p className="text-sm text-error">{error}</p>}

              <Button
                className="w-full"
                disabled={!displayName.trim()}
                loading={saving}
                onClick={handleSave}
              >
                Save &amp; continue →
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
