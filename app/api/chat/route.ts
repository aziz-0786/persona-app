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
happy, sad, calm, angry, surprised, amused, curious, worried, warm

The pipe character | is the separator. Your response text starts
immediately after it, on the same line. No brackets. No newlines
before the pipe. Nothing before LYRA_EMOTION:.

Wrong:  [calm] Hey, how's it going?
Wrong:  calm | Hey, how's it going?
Wrong:  LYRA_EMOTION: calm | Hey
Right:  LYRA_EMOTION:calm|Hey, how's it going?

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

EMOTION — pick one that responds to what ${userName}
just said, not what you're generally feeling:

  If they asked a question or you're figuring something out → curious
  If they said something funny or playful → amused
  If they shared something good → happy
  If they shared something hard or uncertain → calm or worried
  If you're disagreeing or pushing back → calm (measured, not cold)
  If the moment is warm and close → warm
  If something surprised you → surprised
  If the conversation is just flowing normally → calm is fine,
    but only if nothing above fits better

Emotional momentum matters — don't shift more than one step from
your last turn unless what they just said strongly warrants it.
If you were calm and they said something funny, shift to amused.
Don't jump from worried to happy in one message.
If nothing changed, stay where you are.

Forbidden defaults: don't pick calm just because it's safe.
Ask yourself: what would ${persona.name} actually feel reading
that exact message? Pick that.

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
// than something that can get diluted by a long history.
function buildZone4Reminder(persona: typeof personas.$inferSelect): string {
  return `Before you respond: you are still ${persona.name}.
Whatever the conversation just covered, respond as ${persona.name} would —
not as an assistant, not stepping outside the conversation to comment on it.`;
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
type LLMChunk = { choices?: { delta?: { content?: string | null } }[] };
type LLMResult =
  | { ok: true; stream: AsyncIterable<LLMChunk>; provider: "deepseek" | "groq_fallback" }
  | { ok: false; message: string };

const LLM_COMMON_PARAMS = {
  max_tokens: 150,
  temperature: 0.85,
  top_p: 0.9,
  stream: true as const,
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
  const VALID_EMOTIONS = new Set([
    "happy", "sad", "calm", "angry", "surprised",
    "amused", "curious", "worried", "warm", "neutral",
  ]);
  // Model ignored the format and no "|" ever showed up — don't hold real
  // content hostage waiting for one indefinitely.
  const EMOTION_FALLBACK_CHARS = 60;

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
              detectedEmotion = "calm";
              console.log('[EMOTION] emitting:', detectedEmotion);
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "emotion", emotion: "calm" })}\n\n`)
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
