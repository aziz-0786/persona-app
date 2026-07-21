"use client";
import { useEffect, useRef } from "react";

// No TS types ship for TalkingHead.js (loaded from a CDN as a raw ES module,
// not an npm package) — `any` is the honest type here, not a shortcut.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TalkingHeadInstance = any;

interface Props {
  avatarUrl?: string;
  emotion?: string;
  onReady?: (head: TalkingHeadInstance) => void;
}

// TalkingHead.js isn't published to npm — /public/load-talkinghead.js
// imports it from a CDN as a raw ES module and stashes it on `window`. That
// file is served statically (webpack never parses it, so the CDN URL never
// enters the module graph); this function just loads it via a plain
// <script type="module"> tag and waits for the global to appear.
async function loadTalkingHead(): Promise<TalkingHeadInstance> {
  const w = window as unknown as { __TalkingHead?: TalkingHeadInstance };
  if (w.__TalkingHead) return w.__TalkingHead;

  if (document.querySelector('script[src="/load-talkinghead.js"]')) {
    // Another Avatar3D instance already kicked off the load — poll for it.
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (w.__TalkingHead) {
          clearInterval(interval);
          resolve(w.__TalkingHead);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(interval);
        resolve(null);
      }, 10_000);
    });
  }

  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/load-talkinghead.js";
    script.onload = () => {
      // The module body (which sets window.__TalkingHead) can finish an
      // instant after the script's load event fires — give it a beat.
      setTimeout(() => resolve(w.__TalkingHead ?? null), 200);
    };
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

export default function Avatar3D({ avatarUrl, emotion, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<TalkingHeadInstance>(null);

  useEffect(() => {
    if (!containerRef.current || headRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        // An importmap lets talkinghead.mjs's internal `import "three"`
        // (a bare specifier) resolve in the browser — must be present
        // before load-talkinghead.js's module script runs.
        if (!document.querySelector('script[type="importmap"]')) {
          const map = document.createElement("script");
          map.type = "importmap";
          map.textContent = JSON.stringify({
            imports: {
              three: "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
              "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
            },
          });
          document.head.prepend(map);
          await new Promise((r) => setTimeout(r, 50));
        }

        const TalkingHead = await loadTalkingHead();
        if (!TalkingHead) {
          console.error("[Avatar3D] TalkingHead failed to load");
          return;
        }

        if (cancelled || !containerRef.current) return;

        const head = new TalkingHead(containerRef.current, {
          ttsEndpoint: null,
          cameraView: "head",
          cameraRotateEnable: false,
          cameraX: 0,
          cameraY: 0.1,
          cameraDistance: 0.4,
        });

        // Use TalkingHead's built-in test avatar — guaranteed blend shape compatible.
        // The Avaturn GLB lacks ARKit blend shapes in the format TalkingHead expects.
        const url = "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/avatars/brunette.glb";

        try {
          await head.showAvatar({ url, lipsyncLang: "en" });
        } catch (err) {
          console.error("[Avatar3D] showAvatar failed:", err);
          // Try the guaranteed fallback
          const fallback = "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/avatars/brunette.glb";
          if (url !== fallback) {
            await head.showAvatar({ url: fallback, lipsyncLang: "en" });
          }
        }

        if (cancelled) return;
        headRef.current = head;
        onReady?.(head);
        console.log("[Avatar3D] ready");
      } catch (err) {
        console.error("[Avatar3D] failed to load:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update mood when emotion changes
  useEffect(() => {
    if (!headRef.current) return;
    const moodMap: Record<string, string> = {
      happy: "happy",
      amused: "happy",
      calm: "neutral",
      thinking: "neutral",
      default: "neutral",
      sad: "sad",
      angry: "angry",
      surprised: "neutral",
    };
    headRef.current.setMood?.(moodMap[emotion ?? "default"] ?? "neutral");
  }, [emotion]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "300px",
        background: "transparent",
        borderRadius: "50%",
      }}
    />
  );
}
