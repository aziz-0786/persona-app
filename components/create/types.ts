import type { Persona } from "@/db/schema";

export type PersonaUpdate = Partial<
  Pick<
    Persona,
    | "name"
    | "relationship"
    | "bioJson"
    | "characterCardText"
    | "voiceRefB64"
    | "voiceParamsJson"
    | "avatarUrl"
    | "avatarType"
  >
>;

export interface TabProps {
  persona: Persona;
  patchPersona: (updates: PersonaUpdate) => Promise<Persona>;
  onNext: () => void;
}
