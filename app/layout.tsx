import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Persona — Talk to your digital twin",
  description:
    "Create a consent-first voice-cloned digital persona and have natural conversations.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en" className="dark">
      <body className="bg-void text-text-primary antialiased min-h-screen">
        <SessionProvider session={session}>{children}</SessionProvider>
      </body>
    </html>
  );
}
