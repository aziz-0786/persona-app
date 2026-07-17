"use client";
import { useState } from "react";
import { Button, Textarea } from "@/components/ui";
import { Sparkles, AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { QUESTIONS } from "@/lib/questions";
import type { TabProps } from "./types";
import { SaveStatus, type SaveState } from "./SaveStatus";
import { useBioDraft } from "./useBioDraft";

export function PersonalityTab({ persona, patchPersona, onNext }: TabProps) {
  const { draft, saveField } = useBioDraft(persona, patchPersona);

  const [index, setIndex] = useState<number>(() => {
    const firstUnanswered = QUESTIONS.findIndex((q) => !draft[q.id]?.trim());
    return firstUnanswered === -1 ? QUESTIONS.length : firstUnanswered;
  });
  const [answer, setAnswer] = useState(() => draft[QUESTIONS[index]?.id ?? ""] ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const [cardText, setCardText] = useState(persona.characterCardText ?? "");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [isStub, setIsStub] = useState(false);

  const answeredCount = QUESTIONS.filter((q) => draft[q.id]?.trim()).length;
  const atSummary = index >= QUESTIONS.length;
  const question = QUESTIONS[index];

  function goTo(nextIndex: number) {
    setIndex(nextIndex);
    setAnswer(nextIndex < QUESTIONS.length ? draft[QUESTIONS[nextIndex].id] ?? "" : "");
  }

  async function handleNext() {
    if (answer.trim()) {
      setSaveState("saving");
      try {
        await saveField(question.id, answer.trim());
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }
    goTo(index + 1);
  }

  function handleSkip() {
    goTo(index + 1);
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/personas/generate-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: persona.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setCardText(data.characterCardText);
      setIsStub(!!data.stub);
      await patchPersona({ characterCardText: data.characterCardText });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  if (atSummary) {
    return (
      <div className="flex flex-col h-full min-h-[360px]">
        <div className="flex-1 space-y-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">
              Personality — done
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              {answeredCount} of {QUESTIONS.length} questions answered.
            </p>
          </div>

          <button
            onClick={() => goTo(QUESTIONS.length - 1)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <ArrowLeft size={12} />
            Review answers
          </button>

          <div className="bg-elevated rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-accent" />
              <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Character card
              </p>
            </div>
            {cardText ? (
              <pre className="text-sm text-text-primary whitespace-pre-wrap font-body max-h-64 overflow-y-auto">
                {cardText}
              </pre>
            ) : (
              <p className="text-sm text-text-muted">
                Not generated yet. This turns everything above into a compact prompt that drives
                how {persona.name} talks.
              </p>
            )}

            {cardText && isStub && (
              <p className="text-xs text-warning flex items-center gap-1">
                <AlertTriangle size={12} /> Generated locally — the RunPod LLM endpoint wasn&apos;t
                reachable, so this is a placeholder card.
              </p>
            )}

            <Button onClick={handleGenerate} loading={generating} variant={cardText ? "secondary" : "primary"}>
              {cardText ? <RotateCcw size={16} /> : <Sparkles size={16} />}
              {cardText ? "Regenerate Character Card" : "Generate Character Card"}
            </Button>

            {genError && (
              <div className="flex items-start gap-2 bg-error/10 border border-error/30 rounded-xl p-3 text-sm text-error">
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                <span>{genError}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-between items-center pt-4 border-t border-border">
          <span className="text-xs text-text-muted">Card feeds directly into how they speak</span>
          <Button size="sm" onClick={onNext} disabled={!cardText}>
            Next →
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-[360px]">
      <div className="flex-1 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-text-primary">Personality</h2>
            <p className="text-xs text-text-muted mt-1 uppercase tracking-wide">{question.category}</p>
          </div>
          <SaveStatus state={saveState} />
        </div>

        {/* Progress */}
        <div className="space-y-1.5">
          <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${(index / QUESTIONS.length) * 100}%` }}
            />
          </div>
          <p className="text-xs text-text-muted">
            {index + 1} / {QUESTIONS.length}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-base text-text-primary font-medium">{question.text}</p>
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={question.placeholder}
            rows={5}
            autoFocus
          />
        </div>
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border">
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              onClick={() => goTo(index - 1)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors px-2 py-1"
            >
              <ArrowLeft size={12} />
              Back
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            Skip
          </Button>
        </div>
        <Button size="sm" onClick={handleNext} loading={saveState === "saving"}>
          {index === QUESTIONS.length - 1 ? "Finish" : "Next →"}
        </Button>
      </div>
    </div>
  );
}
