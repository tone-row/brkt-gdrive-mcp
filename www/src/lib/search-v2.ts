import { db } from "@/db/client";

/**
 * V2 search: exact cosine scan over the deduplicated document_vectors table,
 * access-filtered via user_document_access.
 *
 * Deliberately NOT vector_top_k/DiskANN: the corpus is small (~14k deduped
 * vectors ≈ 85 MB), an exact scan on a compact DB is fast and has perfect
 * recall, and the prod DiskANN index was measured returning only ~200 of
 * ~14k rows at k=1000 (disconnected neighbor graph after churn) — an ANN
 * index here is a write tax with a silent recall hole. Re-evaluate only if
 * the deduped corpus grows ~10x.
 */

export interface SearchV2Result {
  document_id: string;
  document_title: string;
  chunk_index: number;
  chunk_text: string;
  similarity: number;
}

export async function searchV2(
  userId: string,
  queryEmbedding: number[],
  limit: number
): Promise<SearchV2Result[]> {
  const t0 = performance.now();
  const result = await db.execute({
    sql: `
      SELECT
        dv.document_id,
        d.title as document_title,
        dv.chunk_index,
        dv.text as chunk_text,
        vector_distance_cos(dv.embedding, vector(?)) as distance
      FROM document_vectors dv
      JOIN documents_v2 d ON d.id = dv.document_id
      JOIN user_document_access uda
        ON uda.document_id = dv.document_id AND uda.user_id = ?
      ORDER BY distance ASC
      LIMIT ?
    `,
    args: [`[${queryEmbedding.join(",")}]`, userId, limit],
  });

  const durationMs = Math.round(performance.now() - t0);
  console.log(
    `[search-v2] path=exact rows=${result.rows.length} limit=${limit} duration_ms=${durationMs}`
  );

  return result.rows.map((row) => ({
    document_id: row.document_id as string,
    document_title: row.document_title as string,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    similarity: 1 - (row.distance as number),
  }));
}
