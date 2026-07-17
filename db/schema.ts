import {
  pgTable,
  text,
  timestamp,
  uuid,
  json,
  integer,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  displayName: text("display_name"), // preferred name; null until /user-setup is completed
  profileBio: text("profile_bio"), // what personas should know about this user
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Auth.js required tables
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
});

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull().unique(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

// ─── Personas ─────────────────────────────────────────────────────────────────

export const personas = pgTable("personas", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  relationship: text("relationship"), // e.g. "friend", "mentor", "self"
  bioJson: json("bio_json").$type<Record<string, string>>(), // 25Q answers
  characterCardText: text("character_card_text"), // generated 300-600 token card
  voiceRefB64: text("voice_ref_b64"), // base64 encoded reference WAV
  voiceParamsJson: json("voice_params_json").$type<{
    exaggeration: number;
    cfg_weight: number;
    temperature: number;
  }>(),
  avatarUrl: text("avatar_url"), // Avaturn GLB URL or uploaded GLB path
  avatarType: text("avatar_type").$type<"avaturn" | "upload" | "vrm" | "default">(),
  consentVersion: text("consent_version"), // e.g. "1.0"
  consentScopeJson: json("consent_scope_json").$type<{
    voiceCloning: boolean;
    shareWithOthers: boolean;
    persistentStorage: boolean;
  }>(),
  consentSignedAt: timestamp("consent_signed_at", { withTimezone: true }),
  consentAudioB64: text("consent_audio_b64"), // recorded spoken consent WAV
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Call Sessions ────────────────────────────────────────────────────────────

export const callSessions = pgTable("call_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  personaId: uuid("persona_id")
    .notNull()
    .references(() => personas.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  transcriptJson: json("transcript_json").$type<
    Array<{ role: "user" | "assistant"; content: string; timestamp: number }>
  >(),
  summaryText: text("summary_text"), // LLM-generated post-call summary
  turnCount: integer("turn_count").default(0),
  durationSeconds: integer("duration_seconds"),
});

// ─── Memories Log ─────────────────────────────────────────────────────────────

export const memoriesLog = pgTable("memories_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  personaId: uuid("persona_id")
    .notNull()
    .references(() => personas.id, { onDelete: "cascade" }),
  text: text("text").notNull(), // the memory fact
  source: text("source").$type<"call" | "chat" | "manual">().default("call"),
  pineconeId: text("pinecone_id"), // ID in Pinecone for sync
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  personas: many(personas),
}));

export const personasRelations = relations(personas, ({ one, many }) => ({
  user: one(users, { fields: [personas.userId], references: [users.id] }),
  callSessions: many(callSessions),
  memoriesLog: many(memoriesLog),
}));

export const callSessionsRelations = relations(callSessions, ({ one }) => ({
  persona: one(personas, {
    fields: [callSessions.personaId],
    references: [personas.id],
  }),
}));

export const memoriesLogRelations = relations(memoriesLog, ({ one }) => ({
  persona: one(personas, {
    fields: [memoriesLog.personaId],
    references: [personas.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Persona = typeof personas.$inferSelect;
export type NewPersona = typeof personas.$inferInsert;
export type CallSession = typeof callSessions.$inferSelect;
export type NewCallSession = typeof callSessions.$inferInsert;
export type MemoryLog = typeof memoriesLog.$inferSelect;
export type NewMemoryLog = typeof memoriesLog.$inferInsert;
