import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import OpenAI from "openai";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { memoriesLog } from "@/db/schema";
import { upsertMemory } from "@/lib/pinecone";

export const runtime = "nodejs";
export const maxDuration = 30;

// Self-contained (not imported from /api/chat/route.ts) since extraction is
// a single non-streaming completion — a fundamentally different shape than
// that route's streaming callLLM. Same provider priority though: DeepSeek
// primary, Groq fallback. Was RunPod until this fix — RUNPOD_LLM_ENDPOINT_ID
// has been commented out in .env since the Groq/DeepSeek migration, so this
// route has been silently no-oping (returning stored:0, stub:true) on every
// real call since then.
async function callExtractionLLM(prompt: string): Promise<string | null> {
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const deepseek = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
      });
      const res = await deepseek.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
        thinking: { type: "disabled" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      return res.choices[0]?.message?.content ?? null;
    } catch (err) {
      console.warn("[MEMORY] DeepSeek extraction failed, falling back to Groq:", err);
    }
  }

  if (process.env.GROQ_API_KEY) {
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const res = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      });
      return res.choices[0]?.message?.content ?? null;
    } catch (err) {
      console.error("[MEMORY] Groq extraction failed too:", err);
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { personaId, transcript } = await req.json();
  if (!personaId || !transcript) {
    return NextResponse.json({ error: "Missing personaId or transcript" }, { status: 400 });
  }

  if (!process.env.DEEPSEEK_API_KEY && !process.env.GROQ_API_KEY) {
    return NextResponse.json({ stored: 0, stub: true });
  }

  // Ask LLM to extract personal facts from the transcript
  const extractionPrompt = `Extract up to 5 specific personal facts or updates that were learned about the user in this conversation. Return ONLY a JSON array of strings. Example: ["User works at a startup", "User lives in Bengaluru"]. If nothing notable was learned, return [].

Conversation transcript:
${transcript}`;

  const content = await callExtractionLLM(extractionPrompt);
  if (content === null) {
    console.error("[MEMORY] extraction failed — DeepSeek and Groq both unavailable/erroring");
    return NextResponse.json({ stored: 0, error: "extraction failed" });
  }

  let facts: string[] = [];
  try {
    facts = JSON.parse(content.replace(/```json|```/g, "").trim());
    if (!Array.isArray(facts)) facts = [];
  } catch {
    facts = [];
  }

  if (facts.length === 0) return NextResponse.json({ stored: 0 });

  // Store in Postgres memories_log — source of truth
  const rows = await db
    .insert(memoriesLog)
    .values(
      facts.map((text) => ({
        personaId,
        text,
        source: "call" as const,
      }))
    )
    .returning();

  // Pinecone upsert for semantic retrieval — never throws (see upsertMemory),
  // so a Pinecone outage can't turn this otherwise-successful commit into an
  // error response. Awaited (not fire-and-forget) since this route runs at
  // call-end, not on the live turn-taking path — a few hundred ms here is
  // fine, unlike /api/chat's SSE stream.
  await upsertMemory(personaId, facts);

  console.log(`[MEMORY] commit complete — postgres: ${rows.length}, facts: ${facts.length}`);
  return NextResponse.json({ stored: rows.length, facts });
}
