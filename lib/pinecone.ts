import { Pinecone } from "@pinecone-database/pinecone";

// Single shared serverless index with Pinecone-hosted embeddings (integrated
// inference) — personas are isolated via namespace, not separate indexes.
export const KNOWLEDGE_INDEX_NAME = "persona-knowledge";
const KNOWLEDGE_INDEX_CLOUD = "aws";
const KNOWLEDGE_INDEX_REGION = "us-east-1";
const EMBED_MODEL = "llama-text-embed-v2";
const EMBED_TEXT_FIELD = "chunk_text";

// Integrated-inference upsert is capped at ~96 records per call.
const UPSERT_BATCH_SIZE = 90;

let client: Pinecone | null = null;

function getClient(): Pinecone {
  if (!client) {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error("PINECONE_API_KEY environment variable is not set");
    }
    client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return client;
}

async function ensureKnowledgeIndex() {
  const pc = getClient();
  const { indexes } = await pc.listIndexes();
  const exists = indexes?.some((idx) => idx.name === KNOWLEDGE_INDEX_NAME);

  if (!exists) {
    await pc.createIndexForModel({
      name: KNOWLEDGE_INDEX_NAME,
      cloud: KNOWLEDGE_INDEX_CLOUD,
      region: KNOWLEDGE_INDEX_REGION,
      embed: {
        model: EMBED_MODEL,
        fieldMap: { text: EMBED_TEXT_FIELD },
      },
      waitUntilReady: true,
    });
  }

  return pc.index(KNOWLEDGE_INDEX_NAME);
}

export interface KnowledgeChunkRecord {
  id: string;
  text: string;
  source: string;
}

// Upserts chunks into the persona's namespace, batched under the integrated
// inference per-call record limit.
export async function upsertKnowledgeChunks(
  personaId: string,
  chunks: KnowledgeChunkRecord[]
): Promise<void> {
  const index = await ensureKnowledgeIndex();
  const namespace = index.namespace(personaId);

  for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE).map((c) => ({
      _id: c.id,
      [EMBED_TEXT_FIELD]: c.text,
      source: c.source,
    }));
    await namespace.upsertRecords(batch);
  }
}

export async function queryKnowledge(
  personaId: string,
  queryText: string,
  topK = 3
): Promise<string[]> {
  const pc = getClient();
  const { indexes } = await pc.listIndexes();
  if (!indexes?.some((idx) => idx.name === KNOWLEDGE_INDEX_NAME)) return [];

  const namespace = pc.index(KNOWLEDGE_INDEX_NAME).namespace(personaId);
  const response = await namespace.searchRecords({
    query: { topK, inputs: { text: queryText } },
    fields: [EMBED_TEXT_FIELD],
  });

  return response.result.hits.map(
    (hit) => (hit.fields as Record<string, string>)[EMBED_TEXT_FIELD]
  );
}

export async function deleteKnowledgeNamespace(personaId: string): Promise<void> {
  const pc = getClient();
  const { indexes } = await pc.listIndexes();
  if (!indexes?.some((idx) => idx.name === KNOWLEDGE_INDEX_NAME)) return;

  await pc.index(KNOWLEDGE_INDEX_NAME).namespace(personaId).deleteAll();
}
