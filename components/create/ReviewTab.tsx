"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Badge } from "@/components/ui";
import { Edit2, Check, X } from "lucide-react";
import { QUESTIONS } from "@/lib/questions";
import { getAnsweredCount } from "@/lib/personaFields";
import type { TabProps } from "./types";
import { SaveStatus, type SaveState } from "./SaveStatus";

export function ReviewTab({ persona, patchPersona }: TabProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [cardText, setCardText] = useState(persona.characterCardText ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [approving, setApproving] = useState(false);

  const hasVoice = !!persona.voiceRefB64;
  const hasAvatar = !!persona.avatarType;
  const answeredCount = getAnsweredCount(persona.bioJson);

  async function saveCardEdit() {
    setSaveState("saving");
    try {
      await patchPersona({ characterCardText: cardText });
      setSaveState("saved");
      setEditing(false);
    } catch {
      setSaveState("error");
    }
  }

  async function handleApprove() {
    setApproving(true);
    try {
      if (cardText !== persona.characterCardText) {
        await patchPersona({ characterCardText: cardText });
      }
      router.push("/");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">Review</h2>
            <p className="text-sm text-text-secondary mt-1">
              Check the character card, then approve to finish building {persona.name}.
            </p>
          </div>
          <SaveStatus state={saveState} />
        </div>

        <div className="flex gap-1.5 flex-wrap">
          <Badge variant={hasVoice ? "success" : "default"}>🎤 Voice {hasVoice ? "✓" : "✗"}</Badge>
          <Badge variant={hasAvatar ? "success" : "default"}>🎭 Avatar {hasAvatar ? "✓" : "✗"}</Badge>
          <Badge variant="accent">
            🧠 {answeredCount}/{QUESTIONS.length} questions answered
          </Badge>
        </div>

        <div className="bg-elevated rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Character card
            </p>
            {!editing ? (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
              >
                <Edit2 size={12} /> Edit
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setCardText(persona.characterCardText ?? "");
                    setEditing(false);
                  }}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
                >
                  <X size={12} /> Cancel
                </button>
                <button
                  onClick={saveCardEdit}
                  className="flex items-center gap-1 text-xs text-success hover:text-success/80 transition-colors"
                >
                  <Check size={12} /> Save
                </button>
              </div>
            )}
          </div>

          {editing ? (
            <textarea
              value={cardText}
              onChange={(e) => setCardText(e.target.value)}
              rows={14}
              className="w-full bg-void border border-border rounded-xl px-3.5 py-2.5 text-sm text-text-primary font-mono resize-none focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50"
            />
          ) : cardText ? (
            <pre className="text-sm text-text-primary whitespace-pre-wrap font-body">{cardText}</pre>
          ) : (
            <p className="text-sm text-text-muted">
              No character card yet — go back to the Personality tab to generate one.
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <span className="text-xs text-text-muted">Approving saves everything and returns you home</span>
        <Button size="sm" onClick={handleApprove} loading={approving} disabled={!cardText}>
          Approve &amp; Save
        </Button>
      </div>
    </div>
  );
}
