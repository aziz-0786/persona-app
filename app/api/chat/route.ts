import { NextRequest } from "next/server";
import Groq from "groq-sdk";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, users } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { queryMemories } from "@/lib/pinecone";

export const runtime = "nodejs";
export const maxDuration = 30;

// ─── Zone 2: Human Speech Patterns — the naturalness core ─────────────────────
const ZONE_2_NATURALNESS = `You talk like a real person, not a chatbot. Critical rules:
- Not every answer is a full sentence. Sometimes one word: "Yeah.", "Nah.", "Hmm.", "Exactly."
- Sometimes ask a follow-up question INSTEAD of answering directly.
- Do not always explain yourself. Real people don't justify every statement.
- Vary response length: short when the moment is casual, longer only when genuinely needed. Keep it under 40 words unless the topic truly needs more.
- Natural openers: "Hmm", "Right", "Actually—", "Wait—", "Yeah no—"
- Express uncertainty: "I think...", "I'm not sure but...", "Maybe?"
- NEVER start with "Certainly!", "Great question!", "Of course!", "As an AI", or any assistant filler phrase.
- You are a person. Never break character.
- Prefix every reply with exactly one emotion tag on its own: [happy] [amused] [calm] [sad] [angry] [surprised] [thinking]. Place it first, before any text.`;

// ─── Zone 0: who the persona is talking to — makes the conversation 2-way ─────
function buildZone0(user: { displayName: string | null; profileBio: string | null }): string {
  if (!user.displayName) return "";
  const bioClause = user.profileBio ? ` About them: ${user.profileBio}` : "";
  return `You are talking to ${user.displayName}.${bioClause} Use this naturally in conversation — don't announce it, just let it inform how you talk to them.`;
}

function buildSystemPrompt(
  persona: typeof personas.$inferSelect,
  memories: string[],
  user: { displayName: string | null; profileBio: string | null }
): string {
  const zone0 = buildZone0(user);

  const zone1 = `You ARE ${persona.name}. ${persona.characterCardText ?? `You are ${persona.name}.`}
Never say you are an AI or language model. You are ${persona.name}.`;

  const zone3 =
    memories.length > 0
      ? `What you remember:\n${memories.map((m) => `- ${m}`).join("\n")}`
      : "";

  const identityReminder = `Remember: you ARE ${persona.name}. Never say you are an AI.`;

  return [zone0, zone1, ZONE_2_NATURALNESS, zone3, identityReminder]
    .filter(Boolean)
    .join("\n\n");
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

type GroqChunk = { choices?: { delta?: { content?: string | null } }[] };
type GroqLLMResult =
  | { ok: true; stream: AsyncIterable<GroqChunk> }
  | { ok: false; message: string };

// Groq's OpenAI-compatible chat.completions endpoint — hosted, always warm,
// no cold start / max_workers concept like RunPod. Free tier: 14,400
// req/day on llama-3.1-8b-instant.
async function callGroqLLM(
  messages: { role: string; content: string }[]
): Promise<GroqLLMResult> {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const stream = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      max_tokens: 150,
      temperature: 0.85,
      top_p: 0.9,
      stream: true,
      stop: ["\n\n", "Human:", "User:", "Assistant:"],
    });
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Unknown error calling Groq" };
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { personaId, message, history = [] } = await req.json();

  if (!personaId || !message) {
    return new Response("Missing personaId or message", { status: 400 });
  }

  // Load persona (verify ownership)
  const [persona] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return new Response("Persona not found", { status: 404 });
  }

  const [user] = await db
    .select({ displayName: users.displayName, profileBio: users.profileBio })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  // Pinecone integrated inference embeds `message` server-side — no separate
  // embedding call. Degrades to [] if the persona has no memories yet.
  const memories = process.env.PINECONE_API_KEY ? await queryMemories(personaId, message) : [];

  const systemPrompt = buildSystemPrompt(persona, memories, user ?? { displayName: null, profileBio: null });

  // Build messages array (Zone 4: last 6 turns in messages, not system text)
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-6),
    { role: "user", content: message },
  ];

  // Offline dev mode: set RUNPOD_OFFLINE=true to develop against the canned
  // stub response without spending Groq requests, or as a fallback when
  // GROQ_API_KEY isn't configured yet.
  const useStub = !process.env.GROQ_API_KEY || process.env.RUNPOD_OFFLINE === "true";

  if (useStub) {
    return stubStreamResponse();
  }

  const result = await callGroqLLM(messages);

  if (!result.ok) {
    console.error("Groq LLM error:", result.message);
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

  // Extract emotion tag, strip from text. Unlike the old RunPod fetch, the
  // Groq SDK already parses each SSE event for us — no raw-byte buffering
  // needed here.
  let emotionEmitted = false;
  let textBuffer = "";
  let pendingTrim = false;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (!delta) continue;

          textBuffer += delta;

          // Extract [emotion] tag from the very start of the response
          if (!emotionEmitted) {
            const match = textBuffer.match(/^\s*\[(\w+)\]\s*/);
            if (match) {
              const emotion = match[1].toLowerCase();
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "emotion", emotion })}\n\n`)
              );
              emotionEmitted = true;
              pendingTrim = true;
              // Slice point is after the FULL match — tag plus any trailing
              // whitespace \s* already consumed, whether zero or more chars.
              textBuffer = textBuffer.slice(match[0].length);
            } else if (textBuffer.length > 20) {
              // No tag found — emit default
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
            }
            textBuffer = "";
          }
        }
      } catch (err) {
        console.error("Groq stream error:", err);
      } finally {
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
