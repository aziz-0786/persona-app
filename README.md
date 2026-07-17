# Persona

A consent-first voice-cloning digital twin platform. Create a voice-cloned, 3D-avatar-embodied AI persona and have natural, human-like conversations with it.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend + API | Next.js 14 App Router, TypeScript, Tailwind |
| STT | Deepgram (cloud WebSocket, streaming, interim results) |
| LLM | RunPod vLLM — Llama 3.1 8B Instruct |
| TTS | Chatterbox TTS on RunPod Serverless (zero-shot voice clone) |
| Avatar | Avaturn (GLB, ARKit blendshapes) + TalkingHead.js |
| Memory / RAG | Pinecone (serverless, integrated inference) |
| Database | Postgres via Drizzle ORM (Neon or Railway) |
| Auth | Auth.js v5 (credentials / magic-link) |
| Deploy | Vercel (Path A) or Railway + Docker (Path B) |

## Quick Start

### 1. Prerequisites

- Node.js 20 LTS
- RunPod account with credits (two endpoints needed — see below)
- Deepgram account ($200 free credit)
- Pinecone account (free tier)
- Neon or Railway Postgres

### 2. Clone and install

```bash
git clone https://github.com/YOUR/persona-app
cd persona-app
npm install
```

### 3. Environment variables

```bash
cp .env.example .env.local
# Fill in all values — see comments in .env.example
```

Required variables:
- `DATABASE_URL` — Postgres connection string
- `AUTH_SECRET` — `openssl rand -base64 32`
- `RUNPOD_API_KEY` — from RunPod Settings → API Keys
- `RUNPOD_LLM_ENDPOINT_ID` — from the vLLM endpoint (see RunPod setup below)
- `RUNPOD_TTS_ENDPOINT_ID` — from the Chatterbox endpoint (see RunPod setup below)
- `DEEPGRAM_API_KEY` — Member role required
- `PINECONE_API_KEY` — free tier works
- `NEXT_PUBLIC_AVATURN_PROJECT` — your Avaturn project subdomain

### 4. Database setup

```bash
npm run db:push
```

### 5. Run locally

```bash
npm run dev
# → http://localhost:3000
```

## RunPod Setup (two endpoints)

### Endpoint A — LLM (vLLM)

1. RunPod Console → Serverless → New Endpoint
2. Template: **vLLM** (official RunPod template)
3. GPU: RTX 4090 (24GB)
4. Environment variables:
   - `MODEL_NAME=meta-llama/Llama-3.1-8B-Instruct`
   - `HF_TOKEN=hf_your_token` (needs Llama model access at huggingface.co)
5. Min workers: 0, Max: 2, Idle timeout: 60s, FlashBoot: ON
6. Copy Endpoint ID → `RUNPOD_LLM_ENDPOINT_ID`

**Test:**
```bash
curl -X POST "https://api.runpod.ai/v2/$RUNPOD_LLM_ENDPOINT_ID/openai/v1/chat/completions" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"meta-llama/Llama-3.1-8B-Instruct","messages":[{"role":"user","content":"Hey, how are you?"}],"max_tokens":50}'
```

### Endpoint B — TTS (Chatterbox)

1. Push this repo to GitHub
2. RunPod Console → Settings → Integrations → Connect GitHub
3. Serverless → New Endpoint → Import Git Repository
4. Dockerfile path: `runpod-worker/Dockerfile`, branch: `main`
5. GPU: RTX 4090 (24GB), same worker config as above
6. Copy Endpoint ID → `RUNPOD_TTS_ENDPOINT_ID`

## Deployment

### Path A — Vercel (free)

```bash
vercel --prod
# Add all env vars in Vercel dashboard → Settings → Environment Variables
# Provision Neon Postgres via Vercel Storage → Create Database
```

Note: `/api/tts` needs `export const maxDuration = 60` (already set).

### Path B — Railway

```bash
# Railway auto-deploys from GitHub using the Dockerfile
# Add PostgreSQL service, copy DATABASE_URL, add all other env vars
```

## Project Structure

```
persona-app/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/  # Auth.js handler
│   │   ├── chat/                # SSE LLM route (RunPod vLLM)
│   │   ├── deepgram-token/      # JWT minting for browser STT
│   │   ├── memory/commit/       # Post-call memory extraction
│   │   ├── personas/            # Persona CRUD
│   │   └── tts/                 # TTS proxy (RunPod Chatterbox)
│   ├── call/[id]/               # P4 — Live call (hero screen)
│   ├── chat/[id]/               # P5 — Text chat
│   ├── create/                  # P2 — Persona creator
│   ├── login/                   # Auth page
│   ├── memory/[id]/             # P6 — Memory center
│   ├── onboard/                 # P1 — Consent gate
│   ├── settings/                # P7 — Settings
│   └── page.tsx                 # P3 — Persona library (home)
├── components/
│   ├── layout/AppShell.tsx      # Nav + page wrapper
│   └── ui/index.tsx             # Button, Card, Badge, Input, etc.
├── db/
│   ├── schema.ts                # Drizzle schema (all tables)
│   └── index.ts                 # Neon connection + Drizzle client
├── lib/
│   ├── auth.ts                  # Auth.js v5 config
│   └── utils.ts                 # cn(), emotion maps, Chatterbox presets
├── runpod-worker/
│   ├── handler.py               # Chatterbox TTS worker
│   ├── Dockerfile               # Worker image
│   ├── requirements.txt         # Pinned deps (transformers==4.46.3 critical)
│   └── test_input.json          # Local test payload
├── .env.example                 # All required env vars
├── Dockerfile                   # App Dockerfile (Railway)
└── railway.json                 # Railway config
```

## Phase Build Order

| Phase | What gets built |
|-------|----------------|
| 1 ✅ | Scaffold: schema, auth, UI shell, empty pages, API stubs, workers |
| 2 | Persona creator: profile form, voice recording, 25Q interview, character card generation |
| 3 | Deepgram STT + `/api/chat` SSE with RunPod LLM, Pinecone RAG, text chat P5 |
| 4 | `/api/tts` + clause splitter + audio queue — voice comes alive |
| 5 | P4 live call: mic loop, interruption, state ring, latency overlay |
| 6 | TalkingHead.js + Avaturn iframe + emotion → expression + lip-sync |
| 7 | Memory commit, P6 memory center, P7 settings, full persona deletion |

## Key Constraints

- **Chatterbox has NO `generate_stream()`** — only `generate()`. Any attempt to call `generate_stream()` fails silently or AttributeErrors.
- **`transformers==4.46.3`** is pinned in the worker and must not change. Chatterbox's Llama backbone depends on this exact version.
- **Deepgram API key must be Member role** — lower roles cannot mint JWTs.
- **Never expose `RUNPOD_API_KEY` to the browser** — always proxy through `/api/tts` and `/api/chat`.

## Legal

Voice cloning is subject to applicable law. This app implements:
- Explicit consent dialog before any voice capture
- Consent logging with timestamp and version
- Full persona deletion (Postgres + Pinecone namespace)
- ELVIS Act / CA AB 1836 / IL BIPA compliance notices

## License

MIT
