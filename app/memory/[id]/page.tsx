import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { memoriesLog, personas, callSessions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, Card } from "@/components/ui";
import { Brain, Clock, Trash2 } from "lucide-react";
import { formatRelativeTime, formatDuration } from "@/lib/utils";

export default async function MemoryPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [persona] = await db
    .select()
    .from(personas)
    .where(
      and(
        eq(personas.id, params.id),
        eq(personas.userId, session.user.id)
      )
    )
    .limit(1);

  if (!persona) redirect("/");

  const memories = await db
    .select()
    .from(memoriesLog)
    .where(eq(memoriesLog.personaId, params.id))
    .orderBy(memoriesLog.createdAt);

  const sessions = await db
    .select()
    .from(callSessions)
    .where(eq(callSessions.personaId, params.id))
    .orderBy(callSessions.startedAt);

  return (
    <AppShell>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            {persona.name} — Memory
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            {memories.length} memories · {sessions.length} sessions
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Memory entries */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <Brain size={16} className="text-accent" />
              <h2 className="font-medium text-text-primary">Memories</h2>
              <Badge variant="accent">{memories.length}</Badge>
            </div>

            {memories.length === 0 && (
              <Card>
                <div className="py-8 text-center text-sm text-text-muted">
                  No memories yet. Have a conversation first.
                </div>
              </Card>
            )}

            {memories.map((memory) => (
              <Card key={memory.id} className="group">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary">{memory.text}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="default" className="text-xs">
                        {memory.source}
                      </Badge>
                      <span className="text-xs text-text-muted">
                        {formatRelativeTime(memory.createdAt)}
                      </span>
                    </div>
                  </div>
                  <form action={`/api/memory/${memory.id}`} method="DELETE">
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-error/10 text-text-muted hover:text-error transition-all"
                      title="Delete memory"
                    >
                      <Trash2 size={13} />
                    </button>
                  </form>
                </div>
              </Card>
            ))}
          </div>

          {/* Session history */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <Clock size={16} className="text-accent" />
              <h2 className="font-medium text-text-primary">Sessions</h2>
              <Badge variant="default">{sessions.length}</Badge>
            </div>

            {sessions.length === 0 && (
              <Card>
                <div className="py-8 text-center text-sm text-text-muted">
                  No sessions yet. Start a call to begin.
                </div>
              </Card>
            )}

            {sessions.map((s) => (
              <Card key={s.id}>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {new Date(s.startedAt).toLocaleDateString()} ·{" "}
                      {new Date(s.startedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <div className="flex items-center gap-2">
                      {s.durationSeconds && (
                        <span className="text-xs text-text-muted">
                          {formatDuration(s.durationSeconds)}
                        </span>
                      )}
                      {s.turnCount && (
                        <Badge variant="default" className="text-xs">
                          {s.turnCount} turns
                        </Badge>
                      )}
                    </div>
                  </div>
                  {s.summaryText && (
                    <p className="text-xs text-text-muted line-clamp-3">
                      {s.summaryText}
                    </p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
