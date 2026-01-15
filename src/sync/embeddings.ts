import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100; // OpenAI allows up to 2048 inputs per request

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return response.data[0]!.embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });

    embeddings.push(...response.data.map((d) => d.embedding));
  }

  return embeddings;
}

/**
 * Convert embedding array to the format expected by Turso's vector functions
 */
export function embeddingToBlob(embedding: number[]): string {
  return `vector('[${embedding.join(",")}]')`;
}
