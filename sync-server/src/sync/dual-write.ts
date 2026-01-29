/**
 * Dual-write module for the V2 sync architecture migration.
 *
 * This module provides functions to write document and chunk data to the new
 * tables (documents_v2, user_document_access, document_vectors) while the old
 * tables remain the primary source of truth.
 *
 * The writes are wrapped in try/catch so failures don't affect the main sync.
 */

import { db } from "../db/client";
import { v4 as uuid } from "uuid";

interface ChunkData {
  index: number;
  text: string;
  embedding: number[];
}

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
 * Write a new document to the V2 tables.
 * Creates the document in documents_v2, adds user access mapping, and writes chunks.
 *
 * @param userId - The user ID
 * @param googleDocId - The Google Doc ID
 * @param title - Document title
 * @param fullText - Full document text
 * @param modifiedTime - Google's modified time
 * @param chunks - Array of chunk data with embeddings
 */
export async function writeDocumentToV2(
  userId: string,
  googleDocId: string,
  title: string,
  fullText: string,
  modifiedTime: string,
  chunks: ChunkData[]
): Promise<void> {
  try {
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
        // Update the document
        await db.execute({
          sql: `UPDATE documents_v2
                SET title = ?, full_text = ?, google_modified_time = ?, updated_at = datetime('now')
                WHERE id = ?`,
          args: [title, fullText, modifiedTime, docV2Id],
        });

        // Delete old vectors and re-create
        await db.execute({
          sql: `DELETE FROM document_vectors WHERE document_id = ?`,
          args: [docV2Id],
        });

        // Insert new vectors
        for (const chunk of chunks) {
          const vectorId = uuid();
          await db.execute({
            sql: `INSERT INTO document_vectors (id, document_id, chunk_index, text, embedding)
                  VALUES (?, ?, ?, ?, vector(?))`,
            args: [
              vectorId,
              docV2Id,
              chunk.index,
              chunk.text,
              `[${chunk.embedding.join(",")}]`,
            ],
          });
        }
      }
    } else {
      // Create new document
      docV2Id = uuid();

      await db.execute({
        sql: `INSERT INTO documents_v2 (id, google_doc_id, title, full_text, google_modified_time)
              VALUES (?, ?, ?, ?, ?)`,
        args: [docV2Id, googleDocId, title, fullText, modifiedTime],
      });

      // Insert vectors
      for (const chunk of chunks) {
        const vectorId = uuid();
        await db.execute({
          sql: `INSERT INTO document_vectors (id, document_id, chunk_index, text, embedding)
                VALUES (?, ?, ?, ?, vector(?))`,
          args: [
            vectorId,
            docV2Id,
            chunk.index,
            chunk.text,
            `[${chunk.embedding.join(",")}]`,
          ],
        });
      }
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

    console.log(`    [V2] Wrote document and ${chunks.length} vectors to new tables`);
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
  chunks: ChunkData[]
): Promise<void> {
  // Update is the same operation as write for V2 tables
  await writeDocumentToV2(userId, googleDocId, title, fullText, modifiedTime, chunks);
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

    // Note: We don't delete the document itself even if no users have access,
    // because another user might add it later. Cleanup of orphaned documents
    // would be a separate maintenance task.
  } catch (error: any) {
    console.error(`    [V2] Failed to remove access from new tables: ${error.message}`);
  }
}
