import { db } from "@/db/client";

/**
 * V2 search over the deduplicated document_vectors table, access-filtered
 * via user_document_access.
 *
 * Primary path: vector_top_k on the tuned DiskANN index
 * (compress_neighbors=float8, max_neighbors=20 — measured 99.5% recall@10,
 * ~500MB shadow size vs 4.2GB at defaults). libsql's search returns at most
 * ~200 candidates regardless of requested k (measured plateau), so we ask
 * for exactly that ceiling and post-filter by access:
 *
 *   The accessible subset of the global top-200, sorted by distance, IS the
 *   user's true top-N as long as it contains >= limit rows — any accessible
 *   vector outside the top-200 is farther than every candidate in it.
 *
 * When the intersection comes up short (small/mid-size corpus share), fall
 * back to an exact scan scoped to the user's own vectors — the planner
 * drives document_vectors through user_document_access, so it reads only
 * that user's embedding blobs (cheap for exactly the users who need it;
 * the largest user virtually never hits the fallback).
 *
 * The fallback is also the error path: if the index is missing or unhealthy
 * the search degrades to exact instead of failing.
 */

// Measured libsql DiskANN result ceiling at our index settings.
const TOP_K_CANDIDATES = 200;

export interface SearchV2Result {
  document_id: string;
  document_title: string;
  chunk_index: number;
  chunk_text: string;
  similarity: number;
}

function mapRows(rows: Record<string, unknown>[]): SearchV2Result[] {
  return rows.map((row) => ({
    document_id: row.document_id as string,
    document_title: row.document_title as string,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    similarity: 1 - (row.distance as number),
  }));
}

export async function searchV2(
  userId: string,
  queryEmbedding: number[],
  limit: number
): Promise<SearchV2Result[]> {
  const vec = `[${queryEmbedding.join(",")}]`;
  const t0 = performance.now();
  let path = "topk";
  let results: SearchV2Result[] | null = null;

  try {
    const result = await db.execute({
      sql: `
        SELECT
          dv.document_id,
          d.title as document_title,
          dv.chunk_index,
          dv.text as chunk_text,
          vector_distance_cos(dv.embedding, vector(?)) as distance
        FROM vector_top_k('document_vectors_embedding_idx', vector(?), ?) AS vt
        JOIN document_vectors dv ON dv.rowid = vt.id
        JOIN documents_v2 d ON d.id = dv.document_id
        JOIN user_document_access uda
          ON uda.document_id = dv.document_id AND uda.user_id = ?
        ORDER BY distance ASC
        LIMIT ?
      `,
      args: [vec, vec, TOP_K_CANDIDATES, userId, limit],
    });
    results = mapRows(result.rows as Record<string, unknown>[]);
    if (results.length < limit) {
      // Not enough of the user's vectors in the global top candidates —
      // only an exact scan can prove whether more matches exist.
      path = "exact-fallback";
      results = null;
    }
  } catch (e: unknown) {
    path = "exact-after-error";
    console.warn(
      `[search-v2] vector_top_k failed, falling back to exact scan: ${e instanceof Error ? e.message : e}`
    );
  }

  if (results === null) {
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
      args: [vec, userId, limit],
    });
    results = mapRows(result.rows as Record<string, unknown>[]);
  }

  const durationMs = Math.round(performance.now() - t0);
  console.log(
    `[search-v2] path=${path} rows=${results.length} limit=${limit} duration_ms=${durationMs}`
  );

  return results;
}
