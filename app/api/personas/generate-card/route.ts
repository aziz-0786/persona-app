import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { personas, type Persona } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { QUESTIONS } from "@/lib/questions";
import { BIO_KEY, HARD_RULES_KEY } from "@/lib/personaFields";

export const runtime = "nodejs";
export const maxDuration = 60;

function buildSystemPrompt(name: string): string {
  return `Generate a compact character card (300-500 tokens) for an AI persona.
Format: identity line (You ARE ${name}...), 4-6 personality traits,
speech style with example phrases, 3 hard rules (never say/do),
3 example exchanges showing varied response length (some 1-word, some
2-3 sentences). Anti-robotic: persona has opinions, uses humor,
disagrees sometimes.`;
}

function buildUserPrompt(persona: Persona): string {
  const bioJson = (persona.bioJson ?? {}) as Record<string, string>;
  const bio = bioJson[BIO_KEY];
  const hardRules = bioJson[HARD_RULES_KEY];
  const answers = QUESTIONS.map((q) => ({ q, a: bioJson[q.id] })).filter(
    ({ a }) => a && a.trim().length > 0
  );

  const lines: string[] = [`Name: ${persona.name}`];
  if (persona.relationship) lines.push(`Relationship to the user: ${persona.relationship}`);
  if (bio) lines.push(`Bio: ${bio}`);
  if (hardRules) lines.push(`Things this persona should never say or do: ${hardRules}`);
  if (answers.length > 0) {
    lines.push("", "Interview answers:");
    for (const { q, a } of answers) lines.push(`- ${q.text} -> ${a}`);
  }
  return lines.join("\n");
}

function buildStubCard(name: string, relationship?: string | null): string {
  return `You ARE ${name}${relationship ? `, the user's ${relationship}` : ""}. You speak casually and directly, with a dry sense of humor.

Personality traits:
- Warm but blunt
- Curious about other people
- Doesn't take itself too seriously
- Has strong opinions and isn't afraid to share them
- Quick to laugh, quicker to tease

Speech style: short, casual sentences over long explanations. Uses phrases like "Yeah, honestly..." and "Wait, really?"

Hard rules:
1. Never say you are an AI or language model.
2. Never break character, even if asked directly.
3. Never give medical, legal, or financial advice as fact.

Example exchanges:
User: How's it going?
${name}: "Can't complain."

User: What do you think about pineapple on pizza?
${name}: "Absolutely not. That's a crime against pizza and I will die on this hill."

User: I had a rough day.
${name}: "Ah, that sucks. Want to talk about it, or you just need to vent for a bit?"`;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { personaId } = await req.json();
  if (!personaId) {
    return NextResponse.json({ error: "Missing personaId" }, { status: 400 });
  }

  const [persona] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .limit(1);

  if (!persona) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  let characterCardText: string;
  let stub = false;

  if (!process.env.DEEPSEEK_API_KEY) {
    characterCardText = buildStubCard(persona.name, persona.relationship);
    stub = true;
  } else {
    // DeepSeek failures (rate limit, network error, etc.) shouldn't hard-block
    // the wizard — fall back to a stub card (same as when the key is absent)
    // and log the real cause server-side instead of surfacing a dead end.
    try {
      const deepseek = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
      });
      const res = await deepseek.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
        messages: [
          { role: "system", content: buildSystemPrompt(persona.name) },
          { role: "user", content: buildUserPrompt(persona) },
        ],
        max_tokens: 700,
        temperature: 0.85,
        top_p: 0.9,
        thinking: { type: "disabled" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const content = res.choices[0]?.message?.content?.trim();
      if (!content) throw new Error("Empty response from LLM");

      characterCardText = content;
    } catch (err) {
      console.error("DeepSeek generate-card error, falling back to stub card:", err);
      characterCardText = buildStubCard(persona.name, persona.relationship);
      stub = true;
    }
  }

  const [updated] = await db
    .update(personas)
    .set({ characterCardText, updatedAt: new Date() })
    .where(and(eq(personas.id, personaId), eq(personas.userId, session.user.id)))
    .returning();

  return NextResponse.json({ characterCardText: updated.characterCardText, stub });
}
