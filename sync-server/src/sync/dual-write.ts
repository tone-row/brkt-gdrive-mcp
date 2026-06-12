/**
 * Dual-write module for the V2 sync architecture migration.
 *
 * This module provides functions to write document and chunk data to the new
 * tables (documents_v2, user_document_access, document_vectors) while the old
 * tables remain the primary source of truth.
 *
 * Vectors are written incrementally: chunks are diffed by content hash, new
 * chunks are inserted before stale ones are deleted, and the document's
 * modified time is bumped last — so a crash never leaves V2 marked as
 * up-to-date while its vectors are incomplete.
 *
 * Embeddings are never regenerated here: a chunk that needed embedding was
 * already embedded for the V1 write (passed in via embeddingsByHash); any
 * other chunk's embedding is copied in SQL from the V1 chunks row that the
 * main sync just wrote.
 *
 * The writes are wrapped in try/catch so failures don't affect the main sync.
 */

import { db, withRetry } from "../db/client";
import { v4 as uuid } from "uuid";
import { diffChunks, type NewChunk } from "./chunk-diff";
import { chunkRowId, loadExistingChunks } from "./chunk-store";

// Chunk rows per Turso batch write. Kept small: every row triggers a DiskANN
// vector-index update server-side, observed at roughly 2-5s per row.
const INSERT_BATCH_SIZE = 5;

// Matches the V1 placeholder convention: a doc carrying this timestamp is
// known to have incomplete vectors and will be re-diffed on the next write.
const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";

/**
 * Check if the new V2 tables exist.
 * Returns false if they don't exist or if there's an error checking.
 */
export async function v2TablesExist(): Promise<boolean> {
  try {
    const result = await db.execute(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('documents_v2', 'user_document_access', 'document_vectors')
    `);
    return result.rows.length === 3;
  } catch {
    return false;
  }
}

/**
 * Insert vectors for the given chunks. Embeddings come from this run's
 * embeddingsByHash map when available, otherwise they're copied in SQL from
 * the V1 chunks row with the same content hash (kept chunks were never
 * re-embedded, but V1 already stores their vectors).
 */
async function insertVectors(
  docV2Id: string,
  v1DocId: string,
  chunks: NewChunk[],
  embeddingsByHash: Map<string, number[]>
): Promise<void> {
  for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + INSERT_BATCH_SIZE);
    await withRetry("insert vectors", () =>
      db.batch(
        batch.map((chunk) => {
          const id = chunkRowId(docV2Id, chunk.index, chunk.hash);
          const embedding = embeddingsByHash.get(chunk.hash);
          if (embedding) {
            return {
              sql: `INSERT OR IGNORE INTO document_vectors (id, document_id, chunk_index, text, content_hash, embedding)
                    VALUES (?, ?, ?, ?, ?, vector(?))`,
              args: [id, docV2Id, chunk.index, chunk.text, chunk.hash, `[${embedding.join(",")}]`],
            };
          }
          return {
            sql: `INSERT OR IGNORE INTO document_vectors (id, document_id, chunk_index, text, content_hash, embedding)
                  SELECT ?, ?, ?, text, content_hash, embedding
                  FROM chunks WHERE document_id = ? AND content_hash = ? LIMIT 1`,
            args: [id, docV2Id, chunk.index, v1DocId, chunk.hash],
          };
        }),
        "write"
      )
    );
  }
}

/**
 * Diff the document's vectors against the new chunk list and apply the delta:
 * insert new vectors first, then fix moved indexes, then delete stale rows.
 */
async function syncVectorsIncrementally(
  docV2Id: string,
  v1DocId: string,
  chunks: NewChunk[],
  embeddingsByHash: Map<string, number[]>
): Promise<void> {
  const existing = await loadExistingChunks("document_vectors", docV2Id);
  const diff = diffChunks(existing, chunks);

  await insertVectors(docV2Id, v1DocId, diff.toEmbed, embeddingsByHash);

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

  console.log(
    `    [V2] Vector diff: ${diff.kept} unchanged, ${diff.toEmbed.length} inserted, ${diff.toReindex.length} moved, ${diff.toDelete.length} deleted`
  );
}

/**
 * Write a document to the V2 tables.
 * Creates/updates the document in documents_v2, adds user access mapping, and
 * incrementally syncs its vectors.
 *
 * @param userId - The user ID
 * @param googleDocId - The Google Doc ID
 * @param title - Document title
 * @param fullText - Full document text
 * @param modifiedTime - Google's modified time
 * @param chunks - Full chunk list for the new text (hashes, no embeddings)
 * @param embeddingsByHash - Embeddings generated this run, keyed by content hash
 * @param v1DocId - This user's V1 documents.id, used to copy embeddings of unchanged chunks
 */
export async function writeDocumentToV2(
  userId: string,
  googleDocId: string,
  title: string,
  fullText: string,
  modifiedTime: string,
  chunks: NewChunk[],
  embeddingsByHash: Map<string, number[]>,
  v1DocId: string
): Promise<void> {
  try {
    // TODO: This SELECT-then-INSERT can race if two users sync the same shared file
    // simultaneously. The user_document_access UPSERT is safe, but document creation
    // could produce duplicates or errors. Consider adding a UNIQUE(google_doc_id)
    // constraint with ON CONFLICT handling.
    // Check if document already exists in documents_v2
    const existingDoc = await db.execute({
      sql: `SELECT id, google_modified_time FROM documents_v2 WHERE google_doc_id = ?`,
      args: [googleDocId],
    });

    let docV2Id: string;

    if (existingDoc.rows.length > 0) {
      // Document exists - check if we need to update it
      docV2Id = existingDoc.rows[0]!.id as string;
      const existingModTime = existingDoc.rows[0]!.google_modified_time as string;

      if (modifiedTime > existingModTime) {
        // Sync vectors BEFORE bumping the modified time: if we crash mid-way,
        // the stale timestamp means the next write re-diffs and converges
        // instead of short-circuiting past incomplete vectors.
        await syncVectorsIncrementally(docV2Id, v1DocId, chunks, embeddingsByHash);

        await withRetry("update documents_v2", () =>
          db.execute({
            sql: `UPDATE documents_v2
                  SET title = ?, full_text = ?, google_modified_time = ?, updated_at = datetime('now')
                  WHERE id = ?`,
            args: [title, fullText, modifiedTime, docV2Id],
          })
        );
      }
    } else {
      // Create new document with a placeholder modified time; bump it only
      // after all vectors are written (same crash-safety as above).
      docV2Id = uuid();

      await withRetry("insert documents_v2", () =>
        db.execute({
          sql: `INSERT INTO documents_v2 (id, google_doc_id, title, full_text, google_modified_time)
                VALUES (?, ?, ?, ?, ?)`,
          args: [docV2Id, googleDocId, title, fullText, PLACEHOLDER_TIME],
        })
      );

      await insertVectors(docV2Id, v1DocId, chunks, embeddingsByHash);

      await withRetry("finalize documents_v2", () =>
        db.execute({
          sql: `UPDATE documents_v2 SET google_modified_time = ? WHERE id = ?`,
          args: [modifiedTime, docV2Id],
        })
      );

      console.log(`    [V2] Wrote document and ${chunks.length} vectors to new tables`);
    }

    // Ensure user has access mapping (upsert)
    const accessId = uuid();
    await db.execute({
      sql: `INSERT INTO user_document_access (id, user_id, document_id, first_seen_at, last_verified_at)
            VALUES (?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(user_id, document_id) DO UPDATE SET
              last_verified_at = datetime('now')`,
      args: [accessId, userId, docV2Id],
    });
  } catch (error: any) {
    // Log but don't fail the sync - V2 tables are not the source of truth yet
    console.error(`    [V2] Failed to write to new tables: ${error.message}`);
  }
}

/**
 * Update an existing document in the V2 tables.
 * Essentially the same as writeDocumentToV2 but explicitly handles updates.
 */
export async function updateDocumentInV2(
  userId: string,
  googleDocId: string,
  title: string,
  fullText: string,
  modifiedTime: string,
  chunks: NewChunk[],
  embeddingsByHash: Map<string, number[]>,
  v1DocId: string
): Promise<void> {
  // Update is the same operation as write for V2 tables
  await writeDocumentToV2(userId, googleDocId, title, fullText, modifiedTime, chunks, embeddingsByHash, v1DocId);
}

/**
 * Remove a user's access to a document in V2.
 * If this was the last user with access, the document itself is NOT deleted
 * (other users might have access via different sharing).
 */
export async function removeUserAccessFromV2(
  userId: string,
  googleDocId: string
): Promise<void> {
  try {
    // Find the document
    const docResult = await db.execute({
      sql: `SELECT id FROM documents_v2 WHERE google_doc_id = ?`,
      args: [googleDocId],
    });

    if (docResult.rows.length === 0) {
      return; // Document doesn't exist in V2
    }

    const docV2Id = docResult.rows[0]!.id as string;

    // Remove user's access
    await db.execute({
      sql: `DELETE FROM user_document_access WHERE user_id = ? AND document_id = ?`,
      args: [userId, docV2Id],
    });

    console.log(`    [V2] Removed user access to document`);

    // TODO: When all users lose access to a shared file, the documents_v2 row
    // persists as an orphan. Add a periodic cleanup job that deletes documents_v2
    // rows with zero user_document_access entries.
    // Note: We don't delete the document itself even if no users have access,
    // because another user might add it later. Cleanup of orphaned documents
    // would be a separate maintenance task.
  } catch (error: any) {
    console.error(`    [V2] Failed to remove access from new tables: ${error.message}`);
  }
}
