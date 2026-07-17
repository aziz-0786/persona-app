"use client";
import { useState } from "react";
import { Input, Textarea, Button } from "@/components/ui";
import type { TabProps } from "./types";
import { BIO_KEY, HARD_RULES_KEY } from "@/lib/personaFields";
import { SaveStatus, type SaveState } from "./SaveStatus";
import { useBioDraft } from "./useBioDraft";
import { RelationshipSelect } from "@/components/RelationshipSelect";

export function ProfileTab({ persona, patchPersona, onNext }: TabProps) {
  const { draft, saveField } = useBioDraft(persona, patchPersona);

  const [name, setName] = useState(persona.name ?? "");
  const [relationship, setRelationship] = useState(persona.relationship ?? "");
  const [bio, setBio] = useState(draft[BIO_KEY] ?? "");
  const [hardRules, setHardRules] = useState(draft[HARD_RULES_KEY] ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function runSave(fn: () => Promise<unknown>) {
    setSaveState("saving");
    try {
      await fn();
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2000);
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">Profile</h2>
            <p className="text-sm text-text-secondary mt-1">
              The basics — who this persona is and what they should never do.
            </p>
          </div>
          <SaveStatus state={saveState} />
        </div>

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (trimmed && trimmed !== persona.name) runSave(() => patchPersona({ name: trimmed }));
          }}
          placeholder="e.g. Priya"
        />

        <RelationshipSelect
          value={relationship}
          onChange={setRelationship}
          onBlur={() => {
            if (relationship !== (persona.relationship ?? ""))
              runSave(() => patchPersona({ relationship }));
          }}
        />

        <Textarea
          label="Short bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          onBlur={() => {
            if (bio !== (draft[BIO_KEY] ?? "")) runSave(() => saveField(BIO_KEY, bio));
          }}
          placeholder="A couple of sentences about who this person is"
          rows={4}
        />

        <Textarea
          label="What should this persona never say or do?"
          value={hardRules}
          onChange={(e) => setHardRules(e.target.value)}
          onBlur={() => {
            if (hardRules !== (draft[HARD_RULES_KEY] ?? ""))
              runSave(() => saveField(HARD_RULES_KEY, hardRules));
          }}
          placeholder="e.g. Never discuss finances. Never give medical advice."
          rows={4}
        />
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">Changes save automatically when you leave a field</span>
        <Button size="sm" onClick={onNext}>
          Next →
        </Button>
      </div>
    </div>
  );
}
