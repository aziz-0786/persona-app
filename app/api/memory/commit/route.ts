import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { memoriesLog } from "@/db/schema";

export const runtime = "nodejs";
export const maxDuration = 30;

const RUNPOD_LLM_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_LLM_ENDPOINT_ID}/openai/v1/chat/completions`;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { personaId, transcript } = await req.json();
  if (!personaId || !transcript) {
    return NextResponse.json({ error: "Missing personaId or transcript" }, { status: 400 });
  }

  if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_LLM_ENDPOINT_ID) {
    return NextResponse.json({ stored: 0, stub: true });
  }

  // Ask LLM to extract personal facts from the transcript
  const extractionPrompt = `Extract up to 5 specific personal facts or updates that were learned about the user in this conversation. Return ONLY a JSON array of strings. Example: ["User works at a startup", "User lives in Bengaluru"]. If nothing notable was learned, return [].

Conversation transcript:
${transcript}`;

  const res = await fetch(RUNPOD_LLM_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.RUNPOD_LLM_MODEL ?? "meta-llama/Llama-3.1-8B-Instruct",
      messages: [{ role: "user", content: extractionPrompt }],
      max_tokens: 300,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    console.error("Memory extraction LLM error:", await res.text());
    return NextResponse.json({ stored: 0, error: "extraction failed" });
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "[]";

  let facts: string[] = [];
  try {
    facts = JSON.parse(content.replace(/```json|```/g, "").trim());
    if (!Array.isArray(facts)) facts = [];
  } catch {
    facts = [];
  }

  if (facts.length === 0) return NextResponse.json({ stored: 0 });

  // Store in Postgres memories_log
  const rows = await db
    .insert(memoriesLog)
    .values(
      facts.map((text) => ({
        personaId,
        text,
        source: "call" as const,
        // Phase 7: also upsert to Pinecone and store pineconeId
      }))
    )
    .returning();

  // Phase 7: upsert each fact to Pinecone
  // await pinecone.index("persona-memories").namespace(personaId).upsert(rows.map(...))

  return NextResponse.json({ stored: rows.length, facts });
}
