"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { decodeB64ToAudioBuffer } from "@/lib/audio";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Anti-repetition filler-phrase playback on a SEPARATE AudioContext from the
// main TTS AudioQueue (lib/audio.ts) — filler and real speech are two
// independent channels so real audio can cut the filler off instantly
// without touching the main queue's own gapless-playback state.
export function useFillerAudio(fillerAudioData: string | null) {
  const fillers = useMemo<string[]>(() => {
    if (!fillerAudioData) return [];
    try {
      const parsed = JSON.parse(fillerAudioData);
      return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
    } catch {
      return [];
    }
  }, [fillerAudioData]);

  // Fisher-Yates deck — reshuffled whenever exhausted so no two consecutive
  // plays repeat the same clip (except unavoidably across a reshuffle
  // boundary with very few fillers).
  const deckRef = useRef<string[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const fillerNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const lastPlayedAtRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const getCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new AudioCtx();
    }
    return audioCtxRef.current;
  }, []);

  const nextFiller = useCallback((): string | null => {
    if (fillers.length === 0) return null;
    if (deckRef.current.length === 0) {
      deckRef.current = shuffle(fillers);
    }
    return deckRef.current.shift() ?? null;
  }, [fillers]);

  const stopFiller = useCallback(() => {
    const ctx = audioCtxRef.current;
    const node = fillerNodeRef.current;
    const gain = gainNodeRef.current;

    if (node) {
      if (ctx && gain) {
        // 10ms fade-out avoids an audible click on a hard stop.
        const now = ctx.currentTime;
        try {
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + 0.01);
        } catch {
          // Ignore — ctx may already be closed.
        }
        setTimeout(() => {
          try {
            node.stop();
          } catch {
            // Already stopped/ended.
          }
        }, 12);
      } else {
        try {
          node.stop();
        } catch {
          // Already stopped/ended.
        }
      }
    }

    fillerNodeRef.current = null;
    setIsPlaying(false);
  }, []);

  const playFiller = useCallback(async () => {
    if (fillers.length === 0) return; // graceful degradation — no fillers loaded

    const b64 = nextFiller();
    if (!b64) return;

    try {
      const ctx = getCtx();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const buffer = await decodeB64ToAudioBuffer(b64, ctx);

      // Stop anything already on the filler channel before starting a new one.
      stopFiller();

      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        if (fillerNodeRef.current === source) {
          fillerNodeRef.current = null;
          setIsPlaying(false);
        }
      };

      fillerNodeRef.current = source;
      gainNodeRef.current = gain;
      lastPlayedAtRef.current = Date.now();
      setIsPlaying(true);
      source.start();
    } catch (err) {
      console.warn("[FillerAudio] playback failed:", err);
    }
  }, [fillers, nextFiller, getCtx, stopFiller]);

  return { playFiller, stopFiller, isPlaying };
}
