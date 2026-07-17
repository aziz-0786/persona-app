import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Card } from "@/components/ui";
import { CHATTERBOX_PRESETS } from "@/lib/utils";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <AppShell>
      <div className="space-y-8 max-w-2xl">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            Settings
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Voice parameters, data, and account
          </p>
        </div>

        {/* Voice presets */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            Voice Parameter Presets
          </h2>
          <Card>
            <div className="space-y-4">
              {Object.entries(CHATTERBOX_PRESETS).map(([emotion, params]) => (
                <div key={emotion} className="flex items-center gap-4">
                  <span className="w-20 text-sm font-medium text-text-primary capitalize">
                    {emotion}
                  </span>
                  <div className="flex gap-4 text-xs text-text-muted font-mono">
                    <span>exag: {params.exaggeration}</span>
                    <span>cfg: {params.cfg_weight}</span>
                    <span>temp: {params.temperature}</span>
                  </div>
                </div>
              ))}
              <p className="text-xs text-text-muted pt-2 border-t border-border">
                Per-persona overrides coming in Phase 7
              </p>
            </div>
          </Card>
        </section>

        {/* Deepgram */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            Speech Recognition
          </h2>
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-primary">STT Provider</span>
                <span className="text-sm text-text-muted">Deepgram</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-primary">Model</span>
                <span className="text-sm font-mono text-accent">nova-3</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-primary">Endpointing</span>
                <span className="text-sm font-mono text-text-muted">300ms</span>
              </div>
            </div>
          </Card>
        </section>

        {/* Account */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            Account
          </h2>
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-primary">Email</span>
                <span className="text-sm text-text-muted">{session.user.email}</span>
              </div>
            </div>
          </Card>
        </section>

        {/* Danger zone */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-error uppercase tracking-wide">
            Danger Zone
          </h2>
          <Card className="border-error/20">
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-text-primary">
                  Delete Account
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  Permanently deletes your account, all personas, voice samples,
                  and Pinecone memory namespaces.
                </p>
              </div>
              <button className="px-4 py-2 text-sm font-medium text-error bg-error/10 hover:bg-error/20 border border-error/30 rounded-xl transition-colors">
                Delete account and all data
              </button>
            </div>
          </Card>
        </section>
      </div>
    </AppShell>
  );
}
