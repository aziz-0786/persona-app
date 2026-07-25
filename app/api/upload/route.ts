import { put } from "@vercel/blob";
import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File;
  const type = (formData.get("type") as string) || "photo"; // "photo" | "video"

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Size limits
  const maxBytes = type === "video" ? 100 * 1024 * 1024 : 5 * 1024 * 1024;
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `File too large. Max: ${type === "video" ? "100MB" : "5MB"}` },
      { status: 400 }
    );
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Storage not configured (BLOB_READ_WRITE_TOKEN missing). Add it to your env vars." },
      { status: 503 }
    );
  }

  try {
    const blob = await put(
      `persona-${type}s/${session.user.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      file,
      { access: "public", token: process.env.BLOB_READ_WRITE_TOKEN }
    );
    return NextResponse.json({ url: blob.url });
  } catch (e) {
    return NextResponse.json({ error: `Upload failed: ${e}` }, { status: 500 });
  }
}
