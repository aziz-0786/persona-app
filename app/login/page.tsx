"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");

    // Fire-and-forget — starts warming the RunPod TTS worker the instant the
    // user commits to signing in, in parallel with Auth.js doing its thing,
    // not gated on it. sendBeacon survives the page navigation that follows
    // a successful sign-in; a normal un-awaited fetch would risk being
    // cancelled by the browser mid-flight during that navigation.
    if (typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/warmup-runpod");
    } else {
      fetch("/api/warmup-runpod", { method: "POST" }).catch(() => {});
    }
    console.log("[Warmup] Login detected — initial ping fired");

    const result = await signIn("credentials", {
      email: email.trim(),
      redirect: false,
    });

    if (result?.error) {
      setError("Sign in failed. Try again.");
    } else {
      router.push("/");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-void flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="text-center">
          <div className="w-12 h-12 rounded-2xl bg-accent flex items-center justify-center shadow-glow mx-auto mb-3">
            <span className="text-white font-bold text-lg">L</span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            Welcome to Lyra.ai
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Sign in to access your digital twins
          </p>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
            />
            {error && <p className="text-sm text-error">{error}</p>}
            <Button type="submit" className="w-full" loading={loading}>
              Sign in
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-text-muted">
          This is a single-tenant demo. Any email creates an account.
        </p>
      </div>
    </div>
  );
}
