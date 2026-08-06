/**
 * Primary write path for the V2 tables (documents_v2 / user_document_access /
 * document_vectors). These tables are the source of truth: change detection,
 * chunk diffing, and embedding generation all run against them. The legacy V1
 * tables (documents/chunks) are frozen and no longer written.
 *
 * Crash-safety invariants (carried over from the dual-write era):
 * - A new document is created with a placeholder modified time that is bumped
 *   only after all vectors are written; a crash mid-write leaves the stale
 *   timestamp, so the next sync re-diffs and converges.
 * - Updated documents sync vectors BEFORE bumping the modified time, for the
 *   same reason.
 * - New vectors are inserted before stale ones are deleted, so search never
 *   sees a half-empty document.
 * - The user_document_access upsert runs on every call; the vector rewrite
 *   runs only when the incoming modifiedTime is newer than the stored one.
 *   A second user first seeing an already-indexed shared doc gets an access
 *   row without any vector churn.
 *
 * Unlike the dual-write module this replaced, errors are NOT swallowed:
 * V2 is the only copy, so a failed write must fail the file job (the job is
 * retried on the next sync because the document's timestamp stays stale).
 */

import { db, withRetry } from "../db/client";
import { v4 as uuid } from "uuid";
import { chunkText } from "./chunker";
import { generateEmbeddings } from "./embeddings";
import { hashChunk, diffChunks, type NewChunk } from "./chunk-diff";
import { chunkRowId, loadExistingChunks, checkDeadline } from "./chunk-store";

// Chunks per OpenAI embeddings request
const EMBED_BATCH_SIZE = 20;
// Chunk rows per Turso batch write. Kept small: every row triggers a DiskANN
// vector-index update server-side, observed at roughly 2-5s per row.
const INSERT_BATCH_SIZE = 5;

// A doc carrying this timestamp is known to have incomplete vectors and will
// be re-diffed on the next write.
export const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";

export interface DocV2Ref {
  id: string;
  modifiedTime: string;
}

/**
 * Look up a document by its Google Doc ID.
 */
export async function resolveDocV2(googleDocId: string): Promise<DocV2Ref | null> {
  const result = await db.execute({
    sql: `SELECT id, google_modified_time FROM documents_v2 WHERE google_doc_id = ?`,
    args: [googleDocId],
  });
  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0]!.id as string,
    modifiedTime: result.rows[0]!.google_modified_time as string,
  };
}

/**
 * Ensure the user has an access row for the document (upsert).
 */
export async function upsertUserAccess(userId: string, docV2Id: string): Promise<void> {
  await withRetry("upsert user access", () =>
    db.execute({
      sql: `INSERT INTO user_document_access (id, user_id, document_id, first_seen_at, last_verified_at)
            VALUES (?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(user_id, document_id) DO UPDATE SET
              last_verified_at = datetime('now')`,
      args: [uuid(), userId, docV2Id],
    })
  );
}

/**
 * Remove a user's access to a document. The documents_v2 row itself is kept:
 * other users may retain access, and a user who regains access later gets the
 * index back without re-embedding.
 */
export async function removeUserAccess(userId: string, googleDocId: string): Promise<void> {
  const doc = await resolveDocV2(googleDocId);
  if (!doc) return;

  await withRetry("remove user access", () =>
    db.execute({
      sql: `DELETE FROM user_document_access WHERE user_id = ? AND document_id = ?`,
      args: [userId, doc.id],
    })
  );
  console.log(`    [V2] Removed user access to document`);
}

export interface VectorSyncResult {
  /** Full chunk list for the new text */
  chunks: NewChunk[];
  /** How many chunks were embedded this run */
  embedded: number;
  /** How many existing vectors were reused without re-embedding */
  reused: number;
}

/**
 * Bring document_vectors in line with the document's new text, incrementally.
 *
 * Only chunks whose content hash isn't already stored get embedded and
 * inserted; unchanged chunks are left untouched (append-heavy docs re-embed
 * just the tail). New vectors are inserted BEFORE stale ones are deleted, so
 * a crash at any point leaves the search index intact-or-better — the
 * document's stale timestamp makes the next sync converge.
 *
 * Exported for tests.
 */
export async function syncVectorsIncrementally(
  docV2Id: string,
  text: string,
  deadline: number
): Promise<VectorSyncResult> {
  const chunks: NewChunk[] = chunkText(text).map((c) => ({
    index: c.index,
    text: c.text,
    hash: hashChunk(c.text),
  }));

  const existing = await loadExistingChunks("document_vectors", docV2Id);
  const diff = diffChunks(existing, chunks);
  console.log(
    `    [V2] Vector diff: ${diff.kept} unchanged, ${diff.toEmbed.length} to embed, ${diff.toReindex.length} moved, ${diff.toDelete.length} stale`
  );

  let embedded = 0;
  for (let i = 0; i < diff.toEmbed.length; i += EMBED_BATCH_SIZE) {
    checkDeadline(deadline, "embedding chunks");
    const batch = diff.toEmbed.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await generateEmbeddings(batch.map((c) => c.text));
    embedded += batch.length;

    for (let j = 0; j < batch.length; j += INSERT_BATCH_SIZE) {
      checkDeadline(deadline, "inserting vectors");
      const rows = batch.slice(j, j + INSERT_BATCH_SIZE);
      await withRetry("insert vectors", () =>
        db.batch(
          rows.map((c, k) => ({
            sql: `INSERT OR IGNORE INTO document_vectors (id, document_id, chunk_index, text, content_hash, embedding)
                  VALUES (?, ?, ?, ?, ?, vector(?))`,
            args: [
              chunkRowId(docV2Id, c.index, c.hash),
              docV2Id,
              c.index,
              c.text,
              c.hash,
              `[${embeddings[j + k]!.join(",")}]`,
            ],
          })),
          "write"
        )
      );
    }
  }

  if (diff.toReindex.length > 0) {
    await withRetry("reindex vectors", () =>
      db.batch(
        diff.toReindex.map((m) => ({
          sql: `UPDATE document_vectors SET chunk_index = ? WHERE id = ?`,
          args: [m.newIndex, m.id],
        })),
        "write"
      )
    );
  }

  for (let i = 0; i < diff.toDelete.length; i += 100) {
    const ids = diff.toDelete.slice(i, i + 100);
    await withRetry("delete stale vectors", () =>
      db.execute({
        sql: `DELETE FROM document_vectors WHERE id IN (${ids.map(() => "?").join(",")})`,
        args: ids,
      })
    );
  }

  return { chunks, embedded, reused: diff.kept + diff.toReindex.length };
}

/**
 * Write a document: create-or-update documents_v2, incrementally sync its
 * vectors, and ensure the user's access row.
 *
 * Returns whether vectors were (re)written. When the stored copy is already
 * at or past modifiedTime, only the access row is touched — the shared-doc
 * short-circuit.
 */
export async function writeDocumentV2(
  userId: string,
  googleDocId: string,
  title: string,
  fullText: string,
  modifiedTime: string,
  deadline: number
): Promise<{ vectorsWritten: boolean; reused: number; embedded: number }> {
  // ON CONFLICT DO NOTHING + re-select handles two users racing to index the
  // same shared file: exactly one INSERT wins, both proceed against that row.
  await withRetry("insert documents_v2", () =>
    db.execute({
      sql: `INSERT INTO documents_v2 (id, google_doc_id, title, full_text, google_modified_time)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(google_doc_id) DO NOTHING`,
      args: [uuid(), googleDocId, title, fullText, PLACEHOLDER_TIME],
    })
  );
  const doc = (await resolveDocV2(googleDocId))!;

  let result = { vectorsWritten: false, reused: 0, embedded: 0 };

  if (modifiedTime > doc.modifiedTime) {
    // Sync vectors BEFORE bumping the modified time: if we crash mid-way, the
    // stale timestamp means the next sync re-diffs and converges instead of
    // short-circuiting past incomplete vectors.
    const vectors = await syncVectorsIncrementally(doc.id, fullText, deadline);

    await withRetry("finalize documents_v2", () =>
      db.execute({
        sql: `UPDATE documents_v2
              SET title = ?, full_text = ?, google_modified_time = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [title, fullText, modifiedTime, doc.id],
      })
    );
    result = { vectorsWritten: true, reused: vectors.reused, embedded: vectors.embedded };
  }

  await upsertUserAccess(userId, doc.id);
  return result;
}
