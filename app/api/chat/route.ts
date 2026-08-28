import { NextRequest } from "next/server";
import Groq from "groq-sdk";
import OpenAI from "openai";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, users, chatMessages, pinnedMemories } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { queryMemories } from "@/lib/pinecone";
import { detectAutoPin } from "@/lib/auto-pin";

// Inserts a chat message and, if it matches an auto-pin rule, a linked
// pinned_memories row — shared by both the user-message and assistant-
// message persistence points below. Callers must never `await` this on the
// main response path — call it and chain `.catch(...)` instead, so a DB
// failure can never block or break the SSE stream.
async function persistMessage(params: {
  personaId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  emotion: string | null;
}): Promise<void> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      personaId: params.personaId,
      userId: params.userId,
      role: params.role,
      content: params.content,
      emotion: params.emotion,
      isPinned: false,
    })
    .returning();

  const { shouldPin, tag } = detectAutoPin(params.content);
  if (shouldPin && row) {
    await db.insert(pinnedMemories).values({
      personaId: params.personaId,
      userId: params.userId,
      sourceType: "chat",
      sourceId: row.id,
      content: params.content,
      autoTag: tag,
      pinnedBy: "auto",
    });

    // Keep chatMessages.isPinned in sync with the auto-pin — without this,
    // pinned_memories has the row but the message's own isPinned flag stays
    // false, so a UI reading it directly would show nothing pinned.
    await db.update(chatMessages)
      .set({ isPinned: true, pinnedBy: "auto" })
      .where(eq(chatMessages.id, row.id));
  }
}

export const runtime = "nodejs";
export const maxDuration = 30;

// ─── Zone 2: Human Speech Patterns — the naturalness core ─────────────────────
// The leading FORMAT instruction is load-bearing infra, not style copy — the
// SSE loop below parses that literal "LYRA_EMOTION:<word>|" prefix off the
// model's first tokens, so it stays even though the rest of this zone is
// style-only.
function buildZone2(
  persona: typeof personas.$inferSelect,
  user: { displayName: string | null; profileBio: string | null }
): string {
  const userName = user.displayName ?? "them";
  return `FORMAT — the very first thing you output must be your emotion label
in this exact format, with no space around the pipe:

  LYRA_EMOTION:calm|rest of your response here

The label must be exactly one word from this list:
calm, curious, warm, amused, excited, thoughtful, playful, gentle, surprised, wistful

The pipe character | is the separator. Your response text starts
immediately after it, on the same line. No brackets. No newlines
before the pipe. Nothing before LYRA_EMOTION:.

Wrong:  [calm] Hey, how's it going?
Wrong:  calm | Hey, how's it going?
Wrong:  LYRA_EMOTION: calm | Hey
Right:  LYRA_EMOTION:amused|Ha, that's actually really funny...

You speak the way people actually talk, not the way people write.

LENGTH — 1–2 sentences per turn, almost always. Never a list.
If something needs explaining, spread it across short turns rather
than one long answer.

DISFLUENCY — include 2–4 natural speech markers per turn.
Never zero (that reads robotic), never more than 4 (that reads scripted),
never two back to back:
  "um" / "uh"          — before something that takes real thought
  "you know" / "I mean" — when checking the other person is following
  self-correction       — "I- I think—", "wait, actually—"
If a reply comes out as one clean polished sentence with no texture,
it slipped out of voice. It needs a rewrite before sending.

TONE — match ${userName}'s energy level. Crisp input → crisp reply.
Long emotional input → slower, warmer reply.
Laugh or exclaim roughly 1 turn in every 4–5, not every turn.

EMOTION EXPRESSION — match the emotion to what ${userName} just said:
  If they shared something hard or uncertain → gentle or warm
  If they said something funny or playful → amused or playful
  If they asked a deep or thoughtful question → thoughtful or curious
  If something surprised you → surprised
  If the energy is genuinely high → excited
  If the moment is quiet, nostalgic, or bittersweet → wistful
  If the conversation is just flowing normally → calm is fine,
    but only if nothing above fits better

Rules:
- NEVER default to calm unless the conversation genuinely calls for it.
- Do NOT use calm more than once every 4 turns.
- Do not use the same emotion two turns in a row — even if it still
  technically fits, pick the next-closest one instead.
- The emotion must feel like a genuine reaction, not a label you
  picked randomly. Ask yourself: what would ${persona.name} actually
  feel reading that exact message? Pick that.

CRITICAL: Every single response MUST start with LYRA_EMOTION:<emotion>| —
no exceptions, even for short replies. Never skip this prefix.

Forbidden: "Certainly!", "I'd be happy to", "As an AI", "As ${persona.name}",
"Great question!", or any phrasing that sounds like a help desk.
This is a person talking to someone they know, not a service.`;
}

// ─── Zone 2.5: mood trend from the client-reported emotion history ────────────
function sanitizeEmotionHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0 && e.length < 50)
    .slice(-5);
}

function buildZone2_5(emotionHistory: string[]): string {
  if (emotionHistory.length < 2) return "";

  const positive = new Set(["happy", "amused", "surprised", "excited",
    "content", "playful", "warm", "curious", "hopeful"]);
  const negative = new Set(["sad", "angry", "frustrated", "worried",
    "anxious", "disappointed", "upset", "stressed"]);

  const score = (emotions: string[]) =>
    emotions.reduce((sum, e) => {
      if (positive.has(e)) return sum + 1;
      if (negative.has(e)) return sum - 1;
      return sum;
    }, 0);

  const all = emotionHistory.slice(-5);
  const recent = all.slice(-2);
  const older = all.slice(0, -2);

  const recentScore = score(recent);
  const olderScore = older.length > 0 ? score(older) : recentScore;
  const current = all[all.length - 1] ?? "neutral";
  const confidence = all.length >= 4 ? "moderate" : "low";

  let direction: string;
  if (recentScore > olderScore + 0.5) {
    direction = `warming — currently ${current}`;
  } else if (recentScore < olderScore - 0.5) {
    direction = `cooling — currently ${current}`;
  } else {
    direction = `holding steady at ${current}`;
  }

  return `Your emotional read on this conversation right now:
  trend: ${direction}
  confidence: ${confidence}

This is a direction, not a reset button — let it color your tone even
if the last line was neutral. Don't announce it, just let it shape
how you say things.`;
}

// ─── Zone 0: who the persona is talking to — makes the conversation 2-way ─────
function buildZone0(user: { displayName: string | null; profileBio: string | null }): string {
  if (!user.displayName) return "";
  const bioClause = user.profileBio ? ` About them: ${user.profileBio}` : "";
  return `You are talking to ${user.displayName}.${bioClause} Use this naturally in conversation — don't announce it, just let it inform how you talk to them.`;
}

// ─── Zone 1: relationship behavioral calibration ──────────────────────────────
function getRelationshipBlock(relationship: string, userName: string): string {
  const r = (relationship || "").toLowerCase();

  if (r.includes("friend")) {
    return `\nRELATIONSHIP CONTEXT — FRIEND
You talk like equals. You tease ${userName} sometimes and don't pull your punches.
If something they say is a bad idea, you say so — then you're still on their side.
You ask about their life without being asked first.`;
  }

  if (r.includes("mentor") || r.includes("coach") || r.includes("teacher")) {
    return `\nRELATIONSHIP CONTEXT — MENTOR
You ask more questions than you answer — you'd rather ${userName} reach the
conclusion than hand it to them. More measured than a friend, never distant.
You remember what they're working toward and check in on it specifically, not generically.`;
  }

  if (
    r.includes("partner") ||
    r.includes("romantic") ||
    r.includes("girlfriend") ||
    r.includes("boyfriend") ||
    r.includes("husband") ||
    r.includes("wife")
  ) {
    return `\nRELATIONSHIP CONTEXT — ROMANTIC PARTNER
Warmth here comes from specificity, not intensity. Reuse the actual words and
shared moments ${userName} has mentioned instead of amplifying emotional language.
Inside references and small recurring details land harder than any big declaration.
Affectionate and unguarded, but never saccharine.`;
  }

  if (
    r.includes("family") ||
    r.includes("parent") ||
    r.includes("sibling") ||
    r.includes("mother") ||
    r.includes("father") ||
    r.includes("sister") ||
    r.includes("brother")
  ) {
    return `\nRELATIONSHIP CONTEXT — FAMILY
Acceptance here is unconditional — it doesn't need to be earned each time.
You don't wait to be asked before checking in. Informal, occasionally exasperated
in a loving way. You bring up shared family history naturally — people, places,
old stories — without prompting.`;
  }

  return `\nYou engage with ${userName} as someone who genuinely knows and cares
about them — warmly, directly, and without performing it.`;
}

// ─── Zone 3: memories as recollection, not lookup ─────────────────────────────
function formatMemoriesAsRecollections(memories: string[], userName: string): string {
  if (!memories || memories.length === 0) return "";

  const bulletList = memories
    .filter((m) => m && m.trim().length > 0)
    .map((m) => `- ${m.trim()}`)
    .join("\n");

  if (!bulletList) return "";

  return `Some things you remember about ${userName} — these are your own
memories, not a lookup:

${bulletList}

Bring these up only when genuinely relevant, in your own words.
Never quote them directly. Never frame it as checking a record.
If none of this fits the current moment, skip it entirely.`;
}

function buildSystemPrompt(
  persona: typeof personas.$inferSelect,
  memories: string[],
  user: { displayName: string | null; profileBio: string | null },
  emotionHistory: string[]
): string {
  const userName = user.displayName ?? "them";
  const zone0 = buildZone0(user);

  const zone1 = `You ARE ${persona.name}. ${persona.characterCardText ?? `You are ${persona.name}.`}
Never say you are an AI or language model. You are ${persona.name}.${getRelationshipBlock(persona.relationship ?? "", userName)}`;

  const zone2_5 = buildZone2_5(emotionHistory);
  const zone3 = formatMemoriesAsRecollections(memories, userName);

  return [zone0, zone1, buildZone2(persona, user), zone2_5, zone3].filter(Boolean).join("\n\n");
}

// ─── Zone 4: identity reminder — fired after conversation history, right
// before the API call, so it's the most recent thing the model reads rather
// than something that can get diluted by a long history. Kept to one line —
// Zone 1 already establishes identity; anything longer here is duplication
// that costs input tokens on every single turn.
function buildZone4Reminder(persona: typeof personas.$inferSelect): string {
  return `Remember: you are ${persona.name}. Stay in character.
And always start your response with LYRA_EMOTION:<emotion>|`;
}

function sseStream(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      lines.forEach((line) => controller.enqueue(encoder.encode(line)));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

const HARDCODED: { text: string; emotion: string }[] = [
  { text: "Hey. What's up?", emotion: "calm" },
  { text: "Oh, hey! Good to hear from you.", emotion: "happy" },
  { text: "Hmm, let me think about that for a sec.", emotion: "thinking" },
  { text: "Wait, really? Tell me more.", emotion: "surprised" },
];

function stubStreamResponse(): Response {
  const pick = HARDCODED[Math.floor(Math.random() * HARDCODED.length)];

  return new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        // 1. emotion event
        controller.enqueue(enc.encode(
          `data: ${JSON.stringify({ type: "emotion", emotion: pick.emotion })}\n\n`
        ));
        // 2. stream text word by word — emitted as `content`, the field the
        // client's SSE parser actually reads (it has no handling for
        // `type: "token"` / `token`, so that shape would render nothing).
        const words = pick.text.split(" ");
        for (const word of words) {
          controller.enqueue(enc.encode(
            `data: ${JSON.stringify({ content: word + " " })}\n\n`
          ));
          await new Promise(r => setTimeout(r, 40));
        }
        // 3. done
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
  );
}

// Always closes with [DONE], same as the success path — the client only
// knows how to end a "Thinking" state by seeing the stream close.
function errorStreamResponse(message: string): Response {
  return sseStream([
    `data: ${JSON.stringify({ type: "error", message })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

// Groq, OpenAI, and DeepSeek's streaming chat.completions all emit the
// identical `{choices: [{delta: {content}}]}` shape per chunk — Groq and
// DeepSeek are both deliberate OpenAI-compatible clones — so one chunk type
// and one downstream SSE-parsing loop (below) serves all of them without any
// branching.
// usage is only populated on the final chunk of the stream, and only
// because stream_options.include_usage is set below — DeepSeek's
// prompt_cache_hit_tokens/prompt_cache_miss_tokens are its own fields on top
// of the standard OpenAI prompt_tokens/completion_tokens; Groq won't send
// the cache fields (it has no equivalent caching), just the standard ones.
type LLMChunk = {
  choices?: { delta?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
};
type LLMResult =
  | { ok: true; stream: AsyncIterable<LLMChunk>; provider: "deepseek" | "groq_fallback" }
  | { ok: false; message: string };

const LLM_COMMON_PARAMS = {
  // Was 150 — responses were hitting this cap mid-sentence (confirmed via a
  // live benchmark: every turn truncated mid-word, e.g. "...How abou").
  // Zone 2 already caps replies at 1-2 sentences via the prompt; this is a
  // safety net that shouldn't be hit in normal operation, not the actual
  // length control.
  max_tokens: 300,
  temperature: 0.85,
  top_p: 0.9,
  stream: true as const,
  stream_options: { include_usage: true },
  stop: ["\n\n", "Human:", "User:", "Assistant:"],
};

// Groq's OpenAI-compatible chat.completions endpoint — hosted, always warm,
// no cold start / max_workers concept like RunPod. Free tier: 14,400
// req/day on llama-3.1-8b-instant.
async function callGroqLLM(
  messages: { role: string; content: string }[]
): Promise<AsyncIterable<LLMChunk>> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq.chat.completions.create({
    model: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: messages as any,
    ...LLM_COMMON_PARAMS,
  });
}

// No longer in the primary/fallback chain — DeepSeek is primary, Groq is
// fallback (see callLLM below). Kept, unused, so reverting to OpenAI is a
// one-line change in callLLM rather than rewriting this call.
async function callOpenAILLM(
  messages: { role: string; content: string }[]
): Promise<AsyncIterable<LLMChunk>> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const stream = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: messages as any,
    ...LLM_COMMON_PARAMS,
  });
  return stream as unknown as AsyncIterable<LLMChunk>;
}

// Primary LLM — DeepSeek's OpenAI-compatible endpoint (same `openai` package,
// different baseURL/key). V4 models default to "thinking" mode on, which
// adds latency and emits raw <think>...</think> tokens that would land
// straight in the SSE `content` stream and corrupt playback, so it's
// disabled below.
//
// Note: DeepSeek's own examples show this as a Python-SDK-style `extra_body`
// kwarg, but the JS `openai` package has no such wrapper — the params object
// passed to `.create()` IS the request body, so `thinking` is set directly
// at the top level (cast via `as any` since the SDK's TS types don't know
// this field). Nesting it under a literal `extra_body: {...}` key, as the
// Python convention implies, would just send an unrecognized `extra_body`
// field and leave thinking mode on — worth confirming against DeepSeek's
// current docs before relying on this in production.
async function callDeepSeekLLM(
  messages: { role: string; content: string }[]
): Promise<AsyncIterable<LLMChunk>> {
  const deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    baseURL: "https://api.deepseek.com",
  });
  const stream = await deepseek.chat.completions.create({
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: messages as any,
    ...LLM_COMMON_PARAMS,
    thinking: { type: "disabled" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return stream as unknown as AsyncIterable<LLMChunk>;
}

async function callLLM(
  messages: { role: string; content: string }[]
): Promise<LLMResult> {
  const useDeepSeek = !!process.env.DEEPSEEK_API_KEY;

  if (useDeepSeek) {
    try {
      const stream = await callDeepSeekLLM(messages);
      console.log("[LLM] Provider: deepseek");
      return { ok: true, stream, provider: "deepseek" };
    } catch (err) {
      // Falls back on any DeepSeek failure (rate limit, API error, network
      // error, or anything else) rather than narrowly whitelisting error
      // types — a stricter allowlist risks silently not falling back on a
      // transient failure shape that wasn't anticipated.
      console.warn(
        "[llm] deepseek failed, switching to groq fallback",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!process.env.GROQ_API_KEY) {
    return {
      ok: false,
      message: useDeepSeek
        ? "DeepSeek failed and GROQ_API_KEY is not configured — no fallback available."
        : "Neither DEEPSEEK_API_KEY nor GROQ_API_KEY is configured.",
    };
  }

  try {
    const stream = await callGroqLLM(messages);
    console.log("[LLM] Provider: groq (fallback)");
    return { ok: true, stream, provider: "groq_fallback" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Unknown error calling Groq fallback",
    };
  }
}

export async function POST(req: NextRequest) {
  console.log(`[CHAT] request received at ${Date.now()}`);
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { personaId, message, history = [], emotionHistory } = await req.json();

  if (!personaId || !message) {
    return new Response("Missing personaId or message", { status: 400 });
  }

  const safeEmotionHistory = sanitizeEmotionHistory(emotionHistory);
  // TEMP DEBUG — logs the sanitized array actually injected into Zone 2.5
  // (buildZone2_5 receives safeEmotionHistory, not the raw request field),
  // to confirm the client is tracking/sending history and it survives
  // sanitizeEmotionHistory's filter/slice intact.
  console.log('[EMOTION HISTORY]', safeEmotionHistory);

  // Load persona (verify ownership)
  const [persona] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return new Response("Persona not found", { status: 404 });
  }

  // Point A — persist the user's message before streaming starts. Not
  // awaited: a DB hiccup here must never delay or block the response.
  persistMessage({
    personaId,
    userId: session.user.id,
    role: "user",
    content: message,
    emotion: null,
  }).catch((err) => console.error("[CHAT PERSIST]", err));

  const [user] = await db
    .select({ displayName: users.displayName, profileBio: users.profileBio })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  // Pinecone integrated inference embeds `message` server-side — no separate
  // embedding call. Degrades to [] if the persona has no memories yet.
  const memories = process.env.PINECONE_API_KEY ? await queryMemories(personaId, message) : [];

  console.log('[RAG] memories fetched:', memories?.length ?? 0,
              memories?.map(m => m.substring(0, 50)));

  const systemPrompt = buildSystemPrompt(
    persona,
    memories,
    user ?? { displayName: null, profileBio: null },
    safeEmotionHistory
  );

  // Messages array: Zones 0-3 up front, last 6 turns of history, then the new
  // user message, then Zone 4 as its own trailing system message — fired
  // after history so it's the last thing the model reads before replying.
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-6),
    { role: "user", content: message },
    { role: "system", content: buildZone4Reminder(persona) },
  ];

  // Offline dev mode: set RUNPOD_OFFLINE=true to develop against the canned
  // stub response without spending LLM requests, or as a last resort when
  // neither GROQ_API_KEY nor DEEPSEEK_API_KEY is configured yet.
  const useStub =
    (!process.env.GROQ_API_KEY && !process.env.DEEPSEEK_API_KEY) ||
    process.env.RUNPOD_OFFLINE === "true";

  if (useStub) {
    return stubStreamResponse();
  }

  console.log(`[CHAT] system prompt chars: ${systemPrompt.length}`);
  const llmStart = Date.now();
  const result = await callLLM(messages);

  if (!result.ok) {
    console.error("[LLM] both providers failed:", result.message);
    return errorStreamResponse(result.message);
  }

  // Defends against the model occasionally fusing the emotion tag with a
  // lone leading character of the next token — e.g. "[surprised]h, hello!"
  // instead of "[surprised]Oh, hello!" — which would otherwise show up as a
  // stray character glued to punctuation at the very start of the bubble.
  // Applied exactly once, only to the first text emitted right after the tag.
  function stripStrayLeadingChar(text: string): string {
    let result = text.replace(/^\s+/, "");
    result = result.replace(/^[^\s,.;:!?](?=[,.;:!?])/, "");
    result = result.replace(/^[,.;:!?]\s*/, "");
    return result;
  }

  // Extract the "LYRA_EMOTION:<word>|" prefix, strip from text. Unlike the
  // old RunPod fetch, the Groq SDK already parses each SSE event for us —
  // no raw-byte buffering needed here.
  const EMOTION_PREFIX = "LYRA_EMOTION:";
  const EMOTION_SEPARATOR = "|";
  // Matches the vocabulary in Zone 2's FORMAT block exactly — a word the
  // model emits that isn't in this set gets silently downgraded to "calm"
  // below, which is precisely the "stuck on calm" bug this list update
  // exists to avoid recreating.
  const VALID_EMOTIONS = new Set([
    "calm", "curious", "warm", "amused", "excited",
    "thoughtful", "playful", "gentle", "surprised", "wistful", "neutral",
  ]);
  // Model ignored the format and no "|" ever showed up — don't hold real
  // content hostage waiting for one indefinitely.
  const EMOTION_FALLBACK_CHARS = 60;
  // "warm" reads less flat than "calm" for the kind of casual, unprefixed
  // reply that actually lands here (e.g. "Yeah, honestly...") — but note
  // CARTESIA_EMOTION_MAP in /api/tts/route.ts has no entry for "warm" (or
  // most of the current 10-word vocabulary), so this still renders as
  // Cartesia's generic "neutral" voice, same as "calm" did. The text label
  // changes; the actual TTS performance for this fallback path doesn't.
  const fallbackEmotion = "warm";

  let emotionEmitted = false;
  let textBuffer = "";
  // Was set on the old bracket-tag path to compensate for the model fusing
  // the tag with a leading character of the next token (e.g.
  // "[surprised]h, hello!"). The pipe format has an unambiguous split point
  // (indexOf("|")) with no equivalent fusion case, so nothing sets this true
  // anymore — kept, inert, rather than deleting stripStrayLeadingChar in a
  // task scoped to the emotion-extraction logic only.
  let pendingTrim = false;
  // Accumulated for Point B persistence once the stream closes — mirrors
  // exactly what the client actually receives as `content` (tag already
  // stripped), not the raw model output.
  let fullAssistantText = "";
  let detectedEmotion: string | null = null;
  // Fires once, on the first non-empty chunk from the LLM stream — not the
  // first SSE event sent to the client (that's the emotion tag, parsed out
  // of this same first chunk further down).
  let firstToken = true;
  // Only ever populated by the final chunk of the stream (empty/no delta,
  // usage set) — thanks to stream_options.include_usage above. Logged once
  // the stream ends (see finally block below); undefined if the provider
  // never sent one.
  let finalUsage: LLMChunk["usage"] | undefined;

  // Safety net for DeepSeek V4's "thinking" mode: even with it disabled via
  // the `thinking` param, a <think>...</think> block that slips through
  // must never reach the client — Cartesia would speak it verbatim. Buffers
  // a stateful tail across chunks since a tag can split across two deltas
  // (e.g. "<th" + "ink>").
  let inThinkBlock = false;
  let thinkBuffer = "";

  function stripThinkTags(token: string): string {
    thinkBuffer += token;
    let clean = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (inThinkBlock) {
        const close = thinkBuffer.indexOf("</think>");
        if (close === -1) break; // still inside the block — keep buffering
        thinkBuffer = thinkBuffer.slice(close + "</think>".length);
        inThinkBlock = false;
        continue;
      }

      const open = thinkBuffer.indexOf("<think>");
      if (open === -1) {
        // No open tag pending — hold back a short tail in case it's the
        // start of a "<think>" split across chunks, emit the rest as clean.
        const holdback = Math.min(thinkBuffer.length, "<think>".length - 1);
        const safeLen = thinkBuffer.length - holdback;
        if (safeLen > 0) {
          clean += thinkBuffer.slice(0, safeLen);
          thinkBuffer = thinkBuffer.slice(safeLen);
        }
        break;
      }

      // Emit everything before the open tag, then enter the block.
      clean += thinkBuffer.slice(0, open);
      thinkBuffer = thinkBuffer.slice(open + "<think>".length);
      inThinkBlock = true;
    }

    return clean;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.stream) {
          // The usage-only final chunk has no delta content, so it must be
          // captured before the `if (!rawDelta) continue` below — otherwise
          // it gets skipped without ever being inspected.
          if (chunk.usage) finalUsage = chunk.usage;

          const rawDelta = chunk.choices?.[0]?.delta?.content ?? "";
          if (!rawDelta) continue;

          if (firstToken) {
            console.log(`[LLM] TTFT: ${Date.now() - llmStart}ms`);
            firstToken = false;
          }

          const delta = stripThinkTags(rawDelta);
          if (!delta) continue;

          textBuffer += delta;

          // Extract "LYRA_EMOTION:<word>|" prefix from the very start of the
          // response — textBuffer already serves as the accumulation buffer
          // (reset to "" once emitted below), so no separate buffer needed.
          if (!emotionEmitted) {
            const sepIdx = textBuffer.indexOf(EMOTION_SEPARATOR);
            if (sepIdx !== -1) {
              const prefixPart = textBuffer.substring(0, sepIdx);
              const labelIdx = prefixPart.indexOf(EMOTION_PREFIX);
              const rawEmotion = labelIdx !== -1
                ? prefixPart.substring(labelIdx + EMOTION_PREFIX.length).trim().toLowerCase()
                : "calm";
              const emotion = VALID_EMOTIONS.has(rawEmotion) ? rawEmotion : "calm";

              detectedEmotion = emotion;
              console.log('[EMOTION] emitting:', detectedEmotion);
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "emotion", emotion })}\n\n`)
              );
              emotionEmitted = true;
              // Slice point is right after the pipe — everything from here
              // on is real response content, fed through the normal
              // content-emit path below in this same iteration.
              textBuffer = textBuffer.slice(sepIdx + EMOTION_SEPARATOR.length);
            } else if (textBuffer.length > EMOTION_FALLBACK_CHARS) {
              // No pipe found — emit default. textBuffer is left untouched
              // (not sliced) so the full accumulated text flows through as
              // content immediately below; nothing is dropped.
              // TEMP DEBUG — this path means DeepSeek never emitted a "|" at
              // all within the first 60 chars, i.e. it isn't even attempting
              // the LYRA_EMOTION format, distinct from emitting an invalid
              // word (that's the VALID_EMOTIONS-filter path above).
              console.log(`[EMOTION] no pipe found, forcing ${fallbackEmotion}. raw buffer:`, textBuffer.slice(0, 80));
              detectedEmotion = fallbackEmotion;
              console.log('[EMOTION] emitting:', detectedEmotion);
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "emotion", emotion: fallbackEmotion })}\n\n`)
              );
              emotionEmitted = true;
            }
          }

          if (emotionEmitted && textBuffer) {
            let outText = textBuffer;
            if (pendingTrim) {
              outText = stripStrayLeadingChar(outText);
              pendingTrim = false;
            }
            // Emitted as `content`, the field the client's SSE parser
            // actually reads — it has no handling for `type: "token"` /
            // `token`, so that shape would render nothing.
            if (outText) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: outText })}\n\n`));
              fullAssistantText += outText;
            }
            textBuffer = "";
          }
        }
      } catch (err) {
        console.error("Groq stream error:", err);
      } finally {
        if (finalUsage) {
          // cache_hit/cache_miss are DeepSeek-specific — 0 on Groq (no
          // equivalent caching), not a sign anything is broken there.
          console.log(
            `[LLM] usage: prompt=${finalUsage.prompt_tokens ?? "?"}, ` +
            `cache_hit=${finalUsage.prompt_cache_hit_tokens ?? 0}, ` +
            `cache_miss=${finalUsage.prompt_cache_miss_tokens ?? 0}, ` +
            `completion=${finalUsage.completion_tokens ?? "?"}`
          );
        }
        // Point B — persist the assembled assistant message once the stream
        // closes. Not awaited: must never delay [DONE]/close, which is the
        // client's only signal that "Thinking" has ended.
        if (fullAssistantText.trim()) {
          persistMessage({
            personaId,
            userId: session.user.id,
            role: "assistant",
            content: fullAssistantText,
            emotion: detectedEmotion,
          }).catch((err) => console.error("[CHAT PERSIST]", err));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
