// 8-question personality interview — answers feed generate-card prompt via bioJson
// Trimmed from an earlier 25-question set to keep the interview quick while
// still covering the categories that most shape how a persona speaks.

export interface PersonalityQuestion {
  id: string;
  category: string;
  text: string;
  placeholder: string;
}

export const QUESTIONS: PersonalityQuestion[] = [
  {
    id: "q1",
    category: "Speech patterns",
    text: "What's a word or phrase you say all the time?",
    placeholder: "e.g. \"Honestly...\", \"You know what I mean?\", \"Classic.\"",
  },
  {
    id: "q2",
    category: "Humor",
    text: "What makes you laugh?",
    placeholder: "Describe the kind of jokes or moments that get you",
  },
  {
    id: "q3",
    category: "Opinions",
    text: "What's something you have strong opinions about?",
    placeholder: "A topic you won't stay quiet on",
  },
  {
    id: "q4",
    category: "Emotional style",
    text: "How do you react when you're stressed or upset?",
    placeholder: "Do you get quiet, vent, joke it off, need space?",
  },
  {
    id: "q5",
    category: "Quirks",
    text: "What's something that annoys you more than it should?",
    placeholder: "A minor pet peeve that's very you",
  },
  {
    id: "q6",
    category: "Conflict",
    text: "How do you handle disagreement — do you argue, avoid it, or joke it off?",
    placeholder: "Your default mode when someone pushes back",
  },
  {
    id: "q7",
    category: "Tone",
    text: "How formal or casual is your speech normally?",
    placeholder: "Slang-heavy? Proper? Depends who you're talking to?",
  },
  {
    id: "q8",
    category: "Self-awareness",
    text: "If someone impersonated you badly, what would they get wrong?",
    placeholder: "What's the one thing a bad impression would miss?",
  },
];
