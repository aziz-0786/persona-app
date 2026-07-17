"use client";
import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Card, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { User, Mic, BookOpen, Brain, Smile, Eye, ChevronRight, Check } from "lucide-react";
import type { Persona } from "@/db/schema";
import type { PersonaUpdate } from "@/components/create/types";
import { getAnsweredCount } from "@/lib/personaFields";
import { QUESTIONS } from "@/lib/questions";
import { ProfileTab } from "@/components/create/ProfileTab";
import { VoiceTab } from "@/components/create/VoiceTab";
import { KnowledgeTab } from "@/components/create/KnowledgeTab";
import { PersonalityTab } from "@/components/create/PersonalityTab";
import { AvatarTab } from "@/components/create/AvatarTab";
import { ReviewTab } from "@/components/create/ReviewTab";

type Tab = "profile" | "voice" | "knowledge" | "personality" | "avatar" | "review";

const TABS: { id: Tab; label: string; icon: typeof User; description: string }[] = [
  { id: "profile",     label: "Profile",      icon: User,      description: "Name, relationship, bio" },
  { id: "voice",       label: "Voice",        icon: Mic,       description: "Record or upload reference audio" },
  { id: "knowledge",   label: "Knowledge",    icon: BookOpen,  description: "Paste text, upload docs" },
  { id: "personality", label: "Personality",  icon: Brain,     description: "25-question interview" },
  { id: "avatar",      label: "Avatar",       icon: Smile,     description: "Avaturn or upload GLB" },
  { id: "review",      label: "Review",       icon: Eye,       description: "Character card preview" },
];

function isTabComplete(tab: Tab, persona: Persona): boolean {
  switch (tab) {
    case "profile":
      return !!persona.name && persona.name !== "New Persona";
    case "voice":
      return !!persona.voiceRefB64;
    case "knowledge":
      return false; // lives in Pinecone, not on the persona row — no local signal
    case "personality":
      return getAnsweredCount(persona.bioJson) >= QUESTIONS.length;
    case "avatar":
      return !!persona.avatarType;
    case "review":
      return !!persona.characterCardText;
  }
}

export default function CreatePage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="flex items-center justify-center py-24">
            <Spinner size={24} />
          </div>
        </AppShell>
      }
    >
      <CreatePageInner />
    </Suspense>
  );
}

function CreatePageInner() {
  const params = useSearchParams();
  const personaId = params?.get("id") ?? null;

  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [persona, setPersona] = useState<Persona | null>(null);
  const [loading, setLoading] = useState(!!personaId);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!personaId) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);

    fetch(`/api/personas?id=${personaId}`)
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.json();
      })
      .then((data: Persona) => {
        if (!cancelled) setPersona(data);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [personaId]);

  const patchPersona = useCallback(
    async (updates: PersonaUpdate): Promise<Persona> => {
      if (!personaId) throw new Error("No persona to update");
      const res = await fetch("/api/personas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: personaId, ...updates }),
      });
      if (!res.ok) throw new Error("Failed to save");
      const updated: Persona = await res.json();
      setPersona(updated);
      return updated;
    },
    [personaId]
  );

  const goNext = useCallback(() => {
    setActiveTab((current) => {
      const idx = TABS.findIndex((t) => t.id === current);
      return idx < TABS.length - 1 ? TABS[idx + 1].id : current;
    });
  }, []);

  if (!personaId) {
    return (
      <AppShell>
        <EmptyState
          emoji="🎭"
          title="Let's start with consent"
          body="Every persona begins with the consent flow, so we know who you're cloning and that they've agreed to it."
          href="/onboard"
          linkLabel="Go to consent →"
        />
      </AppShell>
    );
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-24">
          <Spinner size={24} />
        </div>
      </AppShell>
    );
  }

  if (notFound || !persona) {
    return (
      <AppShell>
        <EmptyState
          emoji="🔍"
          title="Persona not found"
          body="It may have been deleted, or you don't have access to it."
          href="/"
          linkLabel="← Back to your personas"
        />
      </AppShell>
    );
  }

  const tabProps = { persona, patchPersona, onNext: goNext };

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            {persona.characterCardText ? "Edit Persona" : "Create Persona"}
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Building <span className="text-text-primary font-medium">{persona.name}</span> step by step
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          {/* Tab sidebar */}
          <div className="lg:w-56 flex-shrink-0">
            <nav className="space-y-1">
              {TABS.map((tab, i) => {
                const done = isTabComplete(tab.id, persona);
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors group",
                      activeTab === tab.id
                        ? "bg-accent/10 text-accent"
                        : "text-text-secondary hover:text-text-primary hover:bg-elevated"
                    )}
                  >
                    <div
                      className={cn(
                        "w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-xs font-bold",
                        done
                          ? "bg-success/20 text-success"
                          : activeTab === tab.id
                          ? "bg-accent text-white"
                          : "bg-elevated text-text-muted"
                      )}
                    >
                      {done ? <Check size={13} /> : i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{tab.label}</div>
                      <div className="text-xs text-text-muted truncate">{tab.description}</div>
                    </div>
                    {activeTab === tab.id && <ChevronRight size={14} className="flex-shrink-0" />}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Tab content */}
          <Card className="flex-1 min-h-[400px]">
            {activeTab === "profile" && <ProfileTab {...tabProps} />}
            {activeTab === "voice" && <VoiceTab {...tabProps} />}
            {activeTab === "knowledge" && <KnowledgeTab {...tabProps} />}
            {activeTab === "personality" && <PersonalityTab {...tabProps} />}
            {activeTab === "avatar" && <AvatarTab {...tabProps} />}
            {activeTab === "review" && <ReviewTab {...tabProps} />}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function EmptyState({
  emoji,
  title,
  body,
  href,
  linkLabel,
}: {
  emoji: string;
  title: string;
  body: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
      <span className="text-4xl">{emoji}</span>
      <div>
        <h1 className="font-display text-lg font-semibold text-text-primary">{title}</h1>
        <p className="text-sm text-text-secondary mt-1 max-w-sm">{body}</p>
      </div>
      <Link
        href={href}
        className="flex items-center gap-2 px-5 py-3 bg-accent hover:bg-accent-hover text-white font-medium rounded-xl transition-colors shadow-glow"
      >
        {linkLabel}
      </Link>
    </div>
  );
}
