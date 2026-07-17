import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui";
import { Phone, MessageCircle, Brain, Edit, Plus } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";

export default async function PersonaLibraryPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const userPersonas = await db
    .select()
    .from(personas)
    .where(eq(personas.userId, session.user.id))
    .orderBy(personas.updatedAt);

  return (
    <AppShell>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold text-text-primary">
              Your Personas
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              {userPersonas.length === 0
                ? "Create your first digital twin"
                : `${userPersonas.length} persona${userPersonas.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          <Link
            href="/create"
            className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-xl transition-colors shadow-glow"
          >
            <Plus size={16} />
            New Persona
          </Link>
        </div>

        {/* Empty state */}
        {userPersonas.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-elevated flex items-center justify-center mb-4">
              <span className="text-3xl">🎭</span>
            </div>
            <h2 className="font-display text-lg font-medium text-text-primary mb-2">
              No personas yet
            </h2>
            <p className="text-sm text-text-secondary max-w-sm mb-6">
              Create a digital twin of a consenting person. Give them a voice,
              an avatar, and a personality.
            </p>
            <Link
              href="/onboard"
              className="flex items-center gap-2 px-5 py-3 bg-accent hover:bg-accent-hover text-white font-medium rounded-xl transition-colors shadow-glow"
            >
              <Plus size={16} />
              Create your first persona
            </Link>
          </div>
        )}

        {/* Persona grid */}
        {userPersonas.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {userPersonas.map((persona) => (
              <PersonaCard key={persona.id} persona={persona} />
            ))}

            {/* Add new card */}
            <Link
              href="/onboard"
              className="group border-2 border-dashed border-border hover:border-accent/50 rounded-2xl p-5 flex flex-col items-center justify-center gap-3 text-text-muted hover:text-accent transition-all duration-200 min-h-[180px]"
            >
              <Plus
                size={24}
                className="group-hover:scale-110 transition-transform"
              />
              <span className="text-sm font-medium">Add persona</span>
            </Link>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function PersonaCard({ persona }: { persona: typeof personas.$inferSelect }) {
  const hasVoice = !!persona.voiceRefB64;
  const hasAvatar = !!persona.avatarUrl;
  const hasCard = !!persona.characterCardText;

  return (
    <div className="bg-surface border border-border rounded-2xl p-5 flex flex-col gap-4 hover:border-accent/30 transition-colors">
      {/* Avatar + name */}
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-xl bg-elevated flex items-center justify-center flex-shrink-0 overflow-hidden">
          {persona.avatarType === "avaturn" && persona.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={persona.avatarUrl}
              alt={persona.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-2xl font-display font-bold text-text-muted">
              {persona.name[0].toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-semibold text-text-primary truncate">
            {persona.name}
          </h3>
          {persona.relationship && (
            <p className="text-xs text-text-muted capitalize">
              {persona.relationship}
            </p>
          )}
        </div>
      </div>

      {/* Status chips */}
      <div className="flex gap-1.5 flex-wrap">
        <Badge variant={hasVoice ? "success" : "default"}>
          🎤 Voice {hasVoice ? "✓" : "—"}
        </Badge>
        <Badge variant={hasAvatar ? "success" : "default"}>
          🎭 Avatar {hasAvatar ? "✓" : "—"}
        </Badge>
        <Badge variant={hasCard ? "accent" : "default"}>
          🧠 Card {hasCard ? "✓" : "—"}
        </Badge>
      </div>

      {/* Updated */}
      <p className="text-xs text-text-muted">
        {formatRelativeTime(persona.updatedAt)}
      </p>

      {/* Actions */}
      <div className="flex gap-2 pt-1 border-t border-border">
        <Link
          href={`/call/${persona.id}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-accent/10 hover:bg-accent/20 text-accent text-xs font-medium rounded-lg transition-colors"
        >
          <Phone size={13} />
          Call
        </Link>
        <Link
          href={`/chat/${persona.id}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-elevated hover:bg-border text-text-secondary text-xs font-medium rounded-lg transition-colors"
        >
          <MessageCircle size={13} />
          Chat
        </Link>
        <Link
          href={`/memory/${persona.id}`}
          className="flex items-center justify-center gap-1.5 px-2.5 py-2 bg-elevated hover:bg-border text-text-secondary text-xs font-medium rounded-lg transition-colors"
        >
          <Brain size={13} />
        </Link>
        <Link
          href={`/create?id=${persona.id}`}
          className="flex items-center justify-center gap-1.5 px-2.5 py-2 bg-elevated hover:bg-border text-text-secondary text-xs font-medium rounded-lg transition-colors"
        >
          <Edit size={13} />
        </Link>
      </div>
    </div>
  );
}
