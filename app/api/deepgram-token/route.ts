import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    return NextResponse.json({ error: "Deepgram not configured" }, { status: 500 });
  }

  // Mint a short-lived JWT so the real API key never reaches the browser
  // Fetch current Deepgram token-grant docs before implementing — API may update
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: 30 }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Deepgram token error:", text);
    return NextResponse.json({ error: "Failed to mint token" }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ token: data.key });
}
