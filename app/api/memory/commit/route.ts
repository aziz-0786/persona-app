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

type IncomingMessage = { role: string; content: string };

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const personaId: string | undefined = body.personaId;
  // Accepts either the flat `transcript` string the real web call page
  // sends today, or a structured `messages` array — built into the same
  // transcript format here so both shapes reach extraction identically.
  const messages: IncomingMessage[] | undefined = Array.isArray(body.messages) ? body.messages : undefined;
  const transcript: string =
    typeof body.transcript === "string"
      ? body.transcript
      : messages
        ? messages.map((m) => `${m.role}: ${m.content}`).join("\n")
        : "";

  if (!personaId || !transcript) {
    return NextResponse.json({ error: "Missing personaId or transcript" }, { status: 400 });
  }

  // messages, when provided, gives an exact user-turn count; otherwise
  // derive it from the transcript's own "role: content" line format (the
  // same format the web call page already builds it in).
  const userMessages = messages
    ? messages.filter((m) => m.role === "user")
    : transcript.split("\n").filter((line) => line.toLowerCase().startsWith("user:"));

  console.log(
    `[MEMORY] commit started — personaId: ${personaId}, transcript chars: ${transcript.length}, user turns: ${userMessages.length}`
  );

  // Skip the extraction LLM call entirely on very short conversations —
  // not worth the cost, and it prevents a "nothing notable" stored:0 from
  // looking identical to a real extraction failure from the outside.
  if (userMessages.length < 2 || transcript.length < 100) {
    console.log(
      `[MEMORY] skipping extraction — transcript too short (${userMessages.length} user turns, ${transcript.length} chars)`
    );
    return NextResponse.json({ stored: 0, skipped: true, reason: "transcript_too_short" });
  }

  if (!process.env.DEEPSEEK_API_KEY && !process.env.GROQ_API_KEY) {
    return NextResponse.json({ stored: 0, stub: true });
  }

  // Ask LLM to extract personal facts from the transcript. Deliberately
  // broader than "specific personal facts" alone — that wording gave the
  // model an easy out to return [] on ordinary small talk (confirmed: a
  // real test conversation about starting a business, genuinely worth
  // remembering, got judged as "nothing notable" under the old wording).
  const extractionPrompt = `Extract up to 5 things worth remembering about the user from this conversation. Cast a wide net — err on the side of extracting something over returning nothing. Include any of:
- Specific personal facts or updates (name, location, job, etc.)
- Topics or activities the user mentioned being interested in
- Preferences expressed, even casually ("I like...", "I don't like...", "I'd rather...")
- Places mentioned, even in passing
- Their mood or emotional state during this conversation, if notable

Return ONLY a JSON array of strings. Example: ["User works at a startup", "User lives in Bengaluru", "User is stressed about an upcoming exam"]. Only return [] if the conversation is truly pure filler (greetings, acknowledgements) with nothing else in it.

Conversation transcript:
${transcript}`;

  const content = await callExtractionLLM(extractionPrompt);
  console.log(`[MEMORY] extraction raw output: "${content?.slice(0, 200)}"`);
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

  console.log(`[MEMORY] extracted facts count: ${facts.length}`);
  if (facts.length === 0) {
    console.log(`[MEMORY] stored:0 reason: LLM extracted no facts from transcript (${transcript.length} chars)`);
    return NextResponse.json({ stored: 0 });
  }

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
