import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import Google from "next-auth/providers/google";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { grantSignupCredits } from "@/lib/credits";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    // Magic link email (production)
    // Email({
    //   server: process.env.EMAIL_SERVER,
    //   from: process.env.EMAIL_FROM,
    // }),

    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // `user` (and its `role` column) is only present on sign-in — a role
      // change made afterwards (e.g. via the admin panel) won't be reflected
      // in this JWT until the user's next sign-in. Acceptable staleness for
      // an admin-promotion flow that isn't self-service.
      if (user) {
        token.userId = user.id;
        token.role = (user as { role?: string }).role ?? "user";
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) session.user.id = token.userId as string;
      if (token.role) session.user.role = token.role as string;
      return session;
    },
  },
  events: {
    // Fires once, on first account creation (DrizzleAdapter), not on every
    // login — so this is the one-time free-tier grant, not a per-session one.
    async createUser({ user }) {
      if (user.id) await grantSignupCredits(user.id);
    },
  },
});

// Type augmentation
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      role?: string; // "user" | "admin" | "owner"
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: string;
  }
}
