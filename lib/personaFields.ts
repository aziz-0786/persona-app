// Well-known keys inside personas.bioJson (a free-form Record<string,string>).
// Profile fields and the 25-question interview answers share one JSON blob,
// so the key names are centralized here rather than re-typed at each call site.
import { QUESTIONS } from "@/lib/questions";

export const BIO_KEY = "bio";
export const HARD_RULES_KEY = "hardRules";

export type BioJson = Record<string, string> | null | undefined;

export function getAnsweredCount(bioJson: BioJson): number {
  if (!bioJson) return 0;
  return QUESTIONS.filter((q) => (bioJson[q.id] ?? "").trim().length > 0).length;
}

export const RELATIONSHIP_OPTIONS = [
  { value: "self", label: "Myself" },
  { value: "friend", label: "Friend" },
  { value: "mentor", label: "Mentor" },
  { value: "public_figure", label: "Public figure" },
  { value: "other", label: "Other" },
] as const;
