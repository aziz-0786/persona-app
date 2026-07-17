// 25-question personality interview — answers feed generate-card prompt via bioJson

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
    category: "Speech patterns",
    text: "How do you greet people you're close to?",
    placeholder: "e.g. a casual \"hey\", a nickname, a running joke",
  },
  {
    id: "q3",
    category: "Humor",
    text: "What makes you laugh?",
    placeholder: "Describe the kind of jokes or moments that get you",
  },
  {
    id: "q4",
    category: "Humor",
    text: "What's your sense of humor like — sarcastic, silly, dry, dark, or something else?",
    placeholder: "Be specific — give an example if you can",
  },
  {
    id: "q5",
    category: "Opinions",
    text: "What's something you have strong opinions about?",
    placeholder: "A topic you won't stay quiet on",
  },
  {
    id: "q6",
    category: "Opinions",
    text: "What's a belief or value you won't compromise on?",
    placeholder: "Something core to who you are",
  },
  {
    id: "q7",
    category: "Interests",
    text: "What's a topic you could talk about for hours?",
    placeholder: "Your go-to rabbit hole",
  },
  {
    id: "q8",
    category: "Interests",
    text: "What's a hobby or interest that defines you?",
    placeholder: "Something people associate with you",
  },
  {
    id: "q9",
    category: "Emotional style",
    text: "How do you react when you're stressed or upset?",
    placeholder: "Do you get quiet, vent, joke it off, need space?",
  },
  {
    id: "q10",
    category: "Emotional style",
    text: "How do you comfort someone who's upset?",
    placeholder: "Your go-to way of showing support",
  },
  {
    id: "q11",
    category: "Emotional style",
    text: "How do you show you care about someone?",
    placeholder: "Words, actions, teasing, quality time?",
  },
  {
    id: "q12",
    category: "Quirks",
    text: "What's something that annoys you more than it should?",
    placeholder: "A minor pet peeve that's very you",
  },
  {
    id: "q13",
    category: "Quirks",
    text: "What do you complain about most often?",
    placeholder: "Your favorite thing to gripe about",
  },
  {
    id: "q14",
    category: "Stories",
    text: "What's a story you tell often?",
    placeholder: "One you've probably repeated a few times",
  },
  {
    id: "q15",
    category: "Stories",
    text: "What's a mistake or regret you don't mind talking about?",
    placeholder: "Something you're open about, not too personal",
  },
  {
    id: "q16",
    category: "Pride",
    text: "What's something you're proud of?",
    placeholder: "An achievement, big or small",
  },
  {
    id: "q17",
    category: "Conflict",
    text: "How do you handle disagreement — do you argue, avoid it, or joke it off?",
    placeholder: "Your default mode when someone pushes back",
  },
  {
    id: "q18",
    category: "Conflict",
    text: "What do you do when you don't know the answer to something?",
    placeholder: "Guess confidently, admit it, deflect with humor?",
  },
  {
    id: "q19",
    category: "Tone",
    text: "How formal or casual is your speech normally?",
    placeholder: "Slang-heavy? Proper? Depends who you're talking to?",
  },
  {
    id: "q20",
    category: "Tone",
    text: "What's your typical response when someone asks how you're doing?",
    placeholder: "Your actual go-to answer, word for word if you can",
  },
  {
    id: "q21",
    category: "Relationships",
    text: "What's a nickname people call you, or one you'd give others?",
    placeholder: "Terms of endearment or running bits",
  },
  {
    id: "q22",
    category: "Relationships",
    text: "What's a running joke or inside-joke style you have with people close to you?",
    placeholder: "Describe the vibe, not necessarily the exact joke",
  },
  {
    id: "q23",
    category: "Boundaries",
    text: "What topics do you avoid or dislike discussing?",
    placeholder: "Things you'd deflect or shut down",
  },
  {
    id: "q24",
    category: "Farewell",
    text: "How do you say goodbye to people?",
    placeholder: "e.g. \"catch you later\", a hug, a specific phrase",
  },
  {
    id: "q25",
    category: "Self-awareness",
    text: "If someone impersonated you badly, what would they get wrong?",
    placeholder: "What's the one thing a bad impression would miss?",
  },
];
