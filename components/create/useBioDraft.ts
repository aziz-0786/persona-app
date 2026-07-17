import { useCallback, useState } from "react";
import type { Persona } from "@/db/schema";
import type { PersonaUpdate } from "./types";

// personas.bioJson holds both Profile-tab fields (bio, hardRules) and the
// 25-question interview answers in one JSON blob. Postgres json columns are
// replaced wholesale on write, so saving one key from a bioJson snapshot
// taken from `persona` (a prop that only refreshes after a round-trip) can
// clobber another key saved moments earlier. Keeping the merged draft in
// local state — and always writing forward from it — avoids that race.
export function useBioDraft(
  persona: Persona,
  patchPersona: (updates: PersonaUpdate) => Promise<Persona>
) {
  const [draft, setDraft] = useState<Record<string, string>>(
    () => (persona.bioJson as Record<string, string>) ?? {}
  );

  const saveField = useCallback(
    (key: string, value: string) => {
      const next = { ...draft, [key]: value };
      setDraft(next);
      return patchPersona({ bioJson: next });
    },
    [draft, patchPersona]
  );

  return { draft, saveField };
}
