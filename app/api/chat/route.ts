import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, users } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 30;

const RUNPOD_LLM_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_LLM_ENDPOINT_ID}/openai/v1/chat/completions`;

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

  // Phase 3: fetch top-3 Pinecone memories by embedding current message
  // const memories = await queryPinecone(personaId, message);
  const memories: string[] = []; // placeholder until Pinecone is wired

  const systemPrompt = buildSystemPrompt(persona, memories, user ?? { displayName: null, profileBio: null });

  // Build messages array (Zone 4: last 6 turns in messages, not system text)
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-6),
    { role: "user", content: message },
  ];

  if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_LLM_ENDPOINT_ID) {
    // Stub response for Phase 1 testing
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const stubLines = [
          `data: ${JSON.stringify({ type: "emotion", emotion: "calm" })}\n\n`,
          `data: ${JSON.stringify({ content: "[calm] Hey. What's up?" })}\n\n`,
          "data: [DONE]\n\n",
        ];
        stubLines.forEach((line) => controller.enqueue(encoder.encode(line)));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  // Call RunPod vLLM (OpenAI-compatible, stream=true)
  const runpodRes = await fetch(RUNPOD_LLM_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.RUNPOD_LLM_MODEL ?? "meta-llama/Llama-3.1-8B-Instruct",
      messages,
      max_tokens: 150,
      temperature: 0.85,
      top_p: 0.9,
      stream: true,
      stop: ["\n\n", "Human:", "User:", "Assistant:"],
    }),
  });

  if (!runpodRes.ok) {
    const err = await runpodRes.text();
    console.error("RunPod LLM error:", err);
    return new Response("LLM error", { status: 502 });
  }

  // Transform RunPod SSE → our SSE (extract emotion tag, strip from text)
  let emotionEmitted = false;
  let textBuffer = "";

  const encoder = new TextEncoder();
  const stream = new TransformStream({
    async transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
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
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ content: textBuffer })}\n\n`)
            );
            textBuffer = "";
          }
        } catch {}
      }
    },
  });

  runpodRes.body!.pipeTo(stream.writable).catch(console.error);

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
