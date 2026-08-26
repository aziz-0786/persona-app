import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { CHATTERBOX_PRESETS } from "@/lib/utils";

// RunPod TTS endpoint: lzgcc945pqi103
// Set max_workers=0 on dashboard when not testing to stop billing.
// Set max_workers=1 before any TTS test session.
// Cold start: ~5-8 min. Warm generation: ~3-30s per clause.

export const runtime = "nodejs";
// Must stay >= the AbortController timeout below (600s) — otherwise the
// platform kills the function before our own timeout ever gets a chance to.
// Phase 4 (Option A): a synchronous 10-minute wait covers cold starts without
// an architecture change. Phase 5 should switch to /run + poll /status/{id}
// instead of blocking a single request for up to 10 minutes.
export const maxDuration = 600;

const RUNPOD_TTS_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_TTS_ENDPOINT_ID}/runsync`;

// ─── Cartesia ───────────────────────────────────────────────────────────────
// Docs fetched 2026-07-28 from docs.cartesia.ai (api-reference/tts/bytes,
// api-reference/voices/clone, use-the-api/api-conventions,
// build-with-cartesia/tts-models/latest). See CARTESIA_MIGRATION_INFO.md.
const CARTESIA_API_URL = "https://api.cartesia.ai";
// Cartesia-Version — pinned to the one valid enum value for the current API
// spec (2026-03-01), not today's date.
const CARTESIA_VERSION = "2026-03-01";
// Was hardcoded to "sonic-3.5" (latest stable snapshot per Cartesia's docs,
// as opposed to "sonic-latest" which is beta/unstable) — now overridable via
// env. NOTE: the "sonic-2" fallback only applies if CARTESIA_MODEL is unset;
// set it explicitly in .env/Railway to avoid silently downgrading from
// sonic-3.5.
const cartesiaModel = process.env.CARTESIA_MODEL ?? 'sonic-3.5';
// 15s: Cartesia's documented latency is sub-90ms for TTS and clone requests
// are typically a couple seconds — anything past 15s is a real failure, not
// a cold start (Cartesia has no cold-start concept, unlike RunPod).
const CARTESIA_TIMEOUT_MS = 15_000;

// Cartesia's generation_config.emotion accepts many values (50+ per the
// docs); mapped only onto the ones our existing persona-emotion vocabulary
// already uses. speed and volume are temporarily disabled on sonic-3.5 —
// emotion is the only generation_config field sent.
const CARTESIA_EMOTION_MAP: Record<string, { emotion: string }> = {
  happy: { emotion: "happy" },
  amused: { emotion: "happy" },
  surprised: { emotion: "surprised" },
  sad: { emotion: "sad" },
  calm: { emotion: "calm" },
  thinking: { emotion: "calm" },
  angry: { emotion: "angry" },
  default: { emotion: "neutral" },
};

function cartesiaHeaders(extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
    "Cartesia-Version": CARTESIA_VERSION,
    ...extra,
  };
}

// Clones a voice from the (already data-URL-stripped) reference WAV bytes.
// Returns the new voice id, or null on any failure — callers fall back to
// RunPod on null rather than surfacing an error, since a clone failure
// shouldn't block TTS entirely when Chatterbox can still serve the request.
async function cartesiaCloneVoice(personaId: string, voiceB64: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARTESIA_TIMEOUT_MS);
  try {
    const wavBytes = Buffer.from(voiceB64, "base64");
    const form = new FormData();
    form.append("clip", new Blob([wavBytes], { type: "audio/wav" }), "reference.wav");
    form.append("name", personaId);
    form.append("language", "en");

    const res = await fetch(`${CARTESIA_API_URL}/voices/clone`, {
      method: "POST",
      headers: cartesiaHeaders(), // no Content-Type — fetch sets the multipart boundary itself
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[TTS] Cartesia clone failed:", res.status, errText);
      return null;
    }

    const data = await res.json();
    if (!data.id) {
      console.error("[TTS] Cartesia clone response missing id:", data);
      return null;
    }
    return data.id as string;
  } catch (err) {
    console.error("[TTS] Cartesia clone threw:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type CartesiaTtsResult = { audio_base64: string; sample_rate: number } | { error: string };

async function cartesiaTtsAttempt(
  text: string,
  voiceId: string,
  emotion: string
): Promise<{ result: CartesiaTtsResult; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARTESIA_TIMEOUT_MS);
  const sampleRate = 24000;
  const emotionCfg = CARTESIA_EMOTION_MAP[emotion] ?? CARTESIA_EMOTION_MAP.default;

  try {
    const res = await fetch(`${CARTESIA_API_URL}/tts/bytes`, {
      method: "POST",
      headers: cartesiaHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model_id: cartesiaModel,
        transcript: text,
        voice: { mode: "id", id: voiceId },
        // WAV/pcm_s16le — a container decodeAudioData can parse client-side,
        // matching the RunPod path's own WAV output exactly.
        output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: sampleRate },
        generation_config: { emotion: emotionCfg.emotion },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[TTS] Cartesia TTS call failed:", res.status, errText);
      return { result: { error: `TTS unavailable — Cartesia returned ${res.status}` }, status: res.status };
    }

    const bytes = await res.arrayBuffer();
    const audio_base64 = Buffer.from(bytes).toString("base64");
    return { result: { audio_base64, sample_rate: sampleRate } };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const reason = isTimeout ? `timed out after ${CARTESIA_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "network error";
    console.error("[TTS] Cartesia TTS call threw:", reason);
    return { result: { error: `TTS unavailable — ${reason}` } };
  } finally {
    clearTimeout(timer);
  }
}

async function cartesiaTts(text: string, voiceId: string, emotion: string): Promise<CartesiaTtsResult> {
  const first = await cartesiaTtsAttempt(text, voiceId, emotion);
  if (first.status === 502) {
    console.log("[TTS] Cartesia returned 502, retrying once after 1500ms");
    await new Promise((r) => setTimeout(r, 1500));
    const second = await cartesiaTtsAttempt(text, voiceId, emotion);
    return second.result;
  }
  return first.result;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { personaId, text, emotion = "default" } = body;

  console.log("[TTS] route hit, body keys:", Object.keys(body));
  console.log("[TTS] text length:", text?.length ?? 0);
  console.log("[TTS] RUNPOD_OFFLINE:", process.env.RUNPOD_OFFLINE);

  if (!personaId || !text) {
    return NextResponse.json({ error: "Missing personaId or text" }, { status: 400 });
  }

  // Stage 1 — ownership + existence check only. Deliberately does NOT select
  // voiceRefB64 (a multi-MB base64 column) — most calls after the first ever
  // clone only need cartesiaVoiceId, and fetching the 4MB reference on every
  // single request was the whole problem being fixed here.
  const [ownership] = await db
    .select({ cartesiaVoiceId: personas.cartesiaVoiceId })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!ownership) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const cartesiaEnabled = !!process.env.CARTESIA_API_KEY;
  let cartesiaVoiceId = ownership.cartesiaVoiceId;

  // Stage 2 — only fetched when actually needed: no Cartesia clone exists
  // yet, or Cartesia is disabled entirely (RunPod always needs the raw
  // reference). Cached here so neither the clone path nor the RunPod
  // fallback below re-queries if the other already loaded it.
  let voiceStage: { voiceRefB64: string | null; voiceParamsJson: unknown } | null = null;

  async function loadVoiceStage(): Promise<{ voiceRefB64: string | null; voiceParamsJson: unknown }> {
    if (voiceStage) return voiceStage;
    const [row] = await db
      .select({ voiceRefB64: personas.voiceRefB64, voiceParamsJson: personas.voiceParamsJson })
      .from(personas)
      .where(eq(personas.id, personaId))
      .limit(1);
    voiceStage = { voiceRefB64: row?.voiceRefB64 ?? null, voiceParamsJson: row?.voiceParamsJson ?? null };
    console.log("[TTS] voiceRefB64 length:", voiceStage.voiceRefB64?.length ?? 0);
    return voiceStage;
  }

  // ── Cartesia path — primary provider when configured ────────────────────
  // NOTE: RUNPOD_OFFLINE has no functional effect on this route today and
  // never has (a stub short-circuit was deliberately removed previously —
  // see the git history / comment this replaced) — preserved exactly as-is,
  // not reintroduced here, since inventing new stub behavior would go beyond
  // "unchanged" for the existing path.
  if (cartesiaEnabled) {
    if (!cartesiaVoiceId) {
      const stage = await loadVoiceStage();

      if (!stage.voiceRefB64) {
        // Sending an empty voice_b64 fails silently on the worker side (see
        // CLAUDE.md persona shape notes) — reject here with a clear reason.
        return NextResponse.json(
          { error: "No voice reference. Go to Create → Voice tab to record one." },
          { status: 422 }
        );
      }

      // Browser recordings/uploads can end up stored as a data URL
      // ("data:audio/wav;base64,AAAA..."). Cartesia's clone endpoint needs
      // the prefix stripped, same as RunPod does below.
      let voiceB64ForClone = stage.voiceRefB64;
      if (voiceB64ForClone.includes(",")) {
        voiceB64ForClone = voiceB64ForClone.split(",")[1];
      }

      const newVoiceId = await cartesiaCloneVoice(personaId, voiceB64ForClone);
      if (newVoiceId) {
        await db.update(personas).set({ cartesiaVoiceId: newVoiceId }).where(eq(personas.id, personaId));
        cartesiaVoiceId = newVoiceId;
        console.log("[TTS] Cartesia clone created for persona", personaId);
      } else {
        // FIX 2 — a concurrent clause's clone request may have already
        // succeeded while this one was in flight (parallel clauses for the
        // same turn each hit this route independently) — re-check before
        // assuming we must fall back to RunPod.
        const [raceCheck] = await db
          .select({ cartesiaVoiceId: personas.cartesiaVoiceId })
          .from(personas)
          .where(eq(personas.id, personaId))
          .limit(1);
        if (raceCheck?.cartesiaVoiceId) {
          cartesiaVoiceId = raceCheck.cartesiaVoiceId;
          console.log('[TTS] race: concurrent clone detected, using existing cartesiaVoiceId');
        }
        // else: clone genuinely failed and no concurrent request rescued it
        // — cartesiaVoiceId stays null, falls through to RunPod below
        // (graceful degradation, not a 502).
      }
    }

    if (cartesiaVoiceId) {
      const start = Date.now();
      const result = await cartesiaTts(text, cartesiaVoiceId, emotion);
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 502 });
      }
      console.log("[TTS] provider: cartesia, ms:", Date.now() - start);
      return NextResponse.json(result);
    }
  }

  // ── RunPod/Chatterbox path — fallback (or primary, if Cartesia unset) ───
  // Reuses Stage 2 if the Cartesia block above already loaded it (clone
  // attempted and failed); otherwise fetches it now.
  const stage = await loadVoiceStage();

  if (!stage.voiceRefB64) {
    // Sending an empty voice_b64 to RunPod fails silently on the worker side
    // (see CLAUDE.md persona shape notes) — reject here with a clear reason
    // instead.
    return NextResponse.json(
      { error: "No voice reference. Go to Create → Voice tab to record one." },
      { status: 422 }
    );
  }

  // Browser recordings/uploads can end up stored as a data URL
  // ("data:audio/wav;base64,AAAA..."). Python's base64.b64decode() chokes on
  // that prefix with "Incorrect padding" — strip it before it ever reaches
  // RunPod. (Belt and suspenders: the worker also defends against this.)
  let voiceB64 = stage.voiceRefB64;
  if (voiceB64.includes(",")) {
    voiceB64 = voiceB64.split(",")[1];
  }

  // Resolve Chatterbox params: persona overrides > emotion preset > default
  const emotionPreset = CHATTERBOX_PRESETS[emotion] ?? CHATTERBOX_PRESETS.default;
  const personaParams = (stage.voiceParamsJson ?? {}) as Partial<typeof emotionPreset>;
  const params = { ...emotionPreset, ...personaParams };

  // Offline/stub short-circuit removed — TTS always calls RunPod now,
  // regardless of RUNPOD_OFFLINE or missing credentials.
  const useStub = false;
  console.log("[TTS] useStub:", useStub, {
    hasApiKey: !!process.env.RUNPOD_API_KEY,
    hasEndpointId: !!process.env.RUNPOD_TTS_ENDPOINT_ID,
    offlineFlag: process.env.RUNPOD_OFFLINE,
  });

  console.log("[TTS] personaId:", personaId);
  console.log("[TTS] sending to RunPod, text:", text?.slice(0, 50));

  // Never throw past this point — the Play button on the client treats any
  // {error} JSON body as a recoverable, per-message failure, not a crash.
  // 600s covers a cold start (~5-8 min); Phase 5 should replace this with
  // /run + poll /status/{id} instead of a single long-blocking request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);

  let runpodRes: Response;
  try {
    runpodRes = await fetch(RUNPOD_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          text,
          persona_id: personaId,
          exaggeration: params.exaggeration,
          cfg_weight: params.cfg_weight,
          temperature: params.temperature,
          voice_b64: voiceB64,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const reason = isTimeout
      ? "timed out after 600s. If the worker is scaled to max_workers=0 it will never dequeue — check the RunPod dashboard."
      : err instanceof Error
        ? err.message
        : "network error";
    console.error("RunPod TTS error:", reason);
    return NextResponse.json({ error: `TTS unavailable — ${reason}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  console.log("[TTS] RunPod status:", runpodRes.status);

  if (!runpodRes.ok) {
    const errText = await runpodRes.text().catch(() => "");
    console.error("RunPod TTS error:", runpodRes.status, errText);
    return NextResponse.json(
      { error: `TTS unavailable — RunPod returned ${runpodRes.status}. Try again in a moment.` },
      { status: 502 }
    );
  }

  type RunpodResult = {
    id?: string;
    status?: string;
    error?: unknown;
    output?: { audio_base64?: string; sample_rate?: number };
    audio_base64?: string;
    sample_rate?: number;
  };

  let data: RunpodResult;
  try {
    data = await runpodRes.json();
  } catch (err) {
    console.error("RunPod TTS malformed response:", err);
    return NextResponse.json({ error: "TTS unavailable — malformed response" }, { status: 502 });
  }

  console.log("[TTS] RunPod keys:", Object.keys(data ?? {}));
  console.log("[TTS] RunPod status field:", data?.status);

  // A cold worker doesn't finish inside runsync's own internal wait window —
  // RunPod hands back IN_QUEUE/IN_PROGRESS with a job id instead of blocking
  // further. Poll /status/{id} until it settles rather than treating that as
  // a missing-audio failure.
  if (data.status === "IN_QUEUE" || data.status === "IN_PROGRESS") {
    const jobId = data.id;
    if (!jobId) {
      return NextResponse.json({ error: "RunPod returned IN_QUEUE with no job ID" }, { status: 502 });
    }

    console.log(`[TTS] Job ${jobId} is ${data.status} — polling...`);

    const pollStart = Date.now();
    const pollTimeout = 300_000; // 5 minutes max
    const pollInterval = 3000; // poll every 3 seconds

    while (Date.now() - pollStart < pollTimeout) {
      await new Promise((r) => setTimeout(r, pollInterval));

      const statusRes = await fetch(
        `https://api.runpod.ai/v2/${process.env.RUNPOD_TTS_ENDPOINT_ID}/status/${jobId}`,
        { headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` } }
      );
      data = await statusRes.json();
      console.log(`[TTS] Poll status: ${data.status}`);

      if (data.status === "COMPLETED") break;
      if (data.status === "FAILED" || data.status === "CANCELLED") {
        return NextResponse.json(
          { error: `RunPod TTS job ${data.status}: ${JSON.stringify(data.error)}` },
          { status: 502 }
        );
      }
      // IN_QUEUE / IN_PROGRESS — keep polling
    }

    if (data.status !== "COMPLETED") {
      return NextResponse.json({ error: "RunPod TTS timed out after 5 minutes" }, { status: 504 });
    }
  }

  console.log("[TTS] RunPod output keys:", Object.keys(data?.output ?? {}));
  console.log(
    "[TTS] audio_base64 length:",
    data?.output?.audio_base64?.length ?? data?.audio_base64?.length ?? 0
  );

  // RunPod runsync (and /status) wrap output in { output: { ... } }
  const output = data.output ?? data;

  if (!output.audio_base64) {
    console.error("RunPod TTS response missing audio_base64:", data);
    return NextResponse.json({ error: "TTS unavailable — empty response" }, { status: 502 });
  }

  return NextResponse.json({
    audio_base64: output.audio_base64,
    sample_rate: output.sample_rate ?? 24000,
  });
}
