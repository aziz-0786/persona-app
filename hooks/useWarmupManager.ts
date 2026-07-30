"use client";
import { useCallback, useEffect, useRef } from "react";

const WARMUP_INTERVAL_MS = 50_000;

// Keeps the RunPod TTS worker warm with a periodic no-op ping (handler.py's
// "mode: warmup" shortcut — see runpod-worker/handler.py — never touches the
// model). Gated entirely on NEXT_PUBLIC_WARMUP_ENABLED so it's a true no-op
// in dev without touching any call sites.
//
// pause()/resume() are for temporary interruptions (entering/leaving /call
// or /chat) and can flip back and forth freely. destroy() is one-way — once
// called (sign-out, unmount), resume() becomes permanently inert until a
// fresh useWarmupManager() instance is created (e.g. after logging back in
// and this hook remounts under the authenticated layout again).
export function useWarmupManager() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pausedRef = useRef(false);
  const destroyedRef = useRef(false);
  // Ref, not module-level — a module-level flag would be shared across every
  // component instance (and survive HMR reloads in dev) instead of tracking
  // this one manager's in-flight ping.
  const isPingingRef = useRef(false);

  const enabled = process.env.NEXT_PUBLIC_WARMUP_ENABLED === "true";

  const ping = useCallback(async () => {
    // A cold RunPod boot can take much longer than the 50s interval — without
    // this, pings stack up indefinitely, each one a fresh fetch racing the
    // last. Skip this tick entirely if the previous ping hasn't resolved yet.
    if (isPingingRef.current) return;
    isPingingRef.current = true;
    try {
      await fetch("/api/warmup-runpod", {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Never throw — a failed warmup ping must never break the app.
    } finally {
      isPingingRef.current = false;
    }
  }, []);

  const start = useCallback(() => {
    if (!enabled || destroyedRef.current || intervalRef.current) return;
    intervalRef.current = setInterval(() => {
      try {
        ping();
      } catch {
        // Swallow — see ping()'s own comment.
      }
    }, WARMUP_INTERVAL_MS);
  }, [enabled, ping]);

  const pause = useCallback(() => {
    if (!enabled || destroyedRef.current) return;
    pausedRef.current = true;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    console.log("[Warmup] Manager paused (in call/chat)");
  }, [enabled]);

  const resume = useCallback(() => {
    if (!enabled || destroyedRef.current || !pausedRef.current) return;
    pausedRef.current = false;
    start();
    console.log("[Warmup] Manager resumed");
  }, [enabled, start]);

  const destroy = useCallback(() => {
    destroyedRef.current = true;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    console.log("[Warmup] Manager destroyed — pings stopped");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    start();
    return () => destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { pause, resume, destroy };
}
