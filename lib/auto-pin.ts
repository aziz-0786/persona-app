// Simple string-matching auto-pin detector — no LLM call, just cheap regex
// checks run inline on every chat message. First matching tag wins; rule
// order below is the priority order.

export type AutoPinResult = { shouldPin: boolean; tag: string | null };

const RULES: { tag: string; patterns: RegExp[] }[] = [
  {
    tag: "birthday",
    patterns: [/birthday/i, /born on/i, /birth date/i, /turns \d+/i],
  },
  {
    tag: "meeting",
    patterns: [/meeting on/i, /meeting at/i, /appointment/i, /let's meet/i, /scheduled for/i],
  },
  {
    tag: "anniversary",
    patterns: [/anniversary/i, /wedding day/i],
  },
  {
    tag: "personal_fact",
    patterns: [
      /i work at/i,
      /i live in/i,
      /my wife/i,
      /my husband/i,
      /my partner/i,
      /my kid/i,
      /my son/i,
      /my daughter/i,
      /my mom/i,
      /my dad/i,
      /my brother/i,
      /my sister/i,
    ],
  },
  {
    tag: "reminder",
    patterns: [/remind me/i, /don't forget/i, /remember that/i],
  },
];

export function detectAutoPin(content: string): AutoPinResult {
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(content))) {
      return { shouldPin: true, tag: rule.tag };
    }
  }
  return { shouldPin: false, tag: null };
}
