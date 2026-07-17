// Splits long text into ~targetSize-char segments, breaking on sentence/paragraph
// boundaries where possible so chunks stay coherent for embedding.
export function chunkText(text: string, targetSize = 500): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const sentences = normalized.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > targetSize) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      for (let i = 0; i < sentence.length; i += targetSize) {
        chunks.push(sentence.slice(i, i + targetSize).trim());
      }
      continue;
    }

    if (current.length + sentence.length + 1 > targetSize) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}
