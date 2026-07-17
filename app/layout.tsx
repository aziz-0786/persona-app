import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = {
  title: "Persona — Talk to your digital twin",
  description:
    "Create a consent-first voice-cloned digital persona and have natural conversations.",
};

// Paths that must never bounce back into the self-onboarding redirect —
// /user-setup itself (avoid a loop), /login (unauthenticated), /api/*
// (route handlers don't render this layout anyway, but kept for clarity).
const SKIP_USER_SETUP_PREFIXES = ["/user-setup", "/login", "/api"];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const pathname = headers().get("x-pathname") ?? "";
  const skipUserSetupCheck = SKIP_USER_SETUP_PREFIXES.some((p) => pathname.startsWith(p));

  if (session?.user && !skipUserSetupCheck) {
    const [user] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (user && !user.displayName) {
      redirect("/user-setup");
    }
  }

  return (
    <html lang="en" className="dark">
      <body className="bg-void text-text-primary antialiased min-h-screen">
        <SessionProvider session={session}>{children}</SessionProvider>
      </body>
    </html>
  );
}
