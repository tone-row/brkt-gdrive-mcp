/**
 * DB-side helpers shared by the V1 (chunks) and V2 (document_vectors) chunk
 * writers: loading existing chunk hashes (with lazy backfill for rows created
 * before the content_hash column existed) and per-file deadlines.
 */

import { createHash } from "node:crypto";
import { db, withRetry } from "../db/client";
import { hashChunk, type ExistingChunk } from "./chunk-diff";

const HASH_BACKFILL_BATCH = 50;

/**
 * Deterministic chunk row id. Makes inserts idempotent: a retried batch (or a
 * re-run after a crash) re-inserts the same id and INSERT OR IGNORE no-ops.
 */
export function chunkRowId(documentId: string, index: number, hash: string): string {
  return createHash("sha256").update(`${documentId}|${index}|${hash}`).digest("hex");
}

/**
 * Load existing chunk rows for a document with their content hashes.
 *
 * Rows created before the content_hash column existed get their hash computed
 * from the text already stored in the DB and persisted back — so legacy data
 * needs no bulk migration and is never re-embedded.
 */
export async function loadExistingChunks(
  table: "chunks" | "document_vectors",
  documentId: string
): Promise<ExistingChunk[]> {
  const result = await withRetry(`load ${table}`, () =>
    db.execute({
      sql: `SELECT id, chunk_index, content_hash FROM ${table} WHERE document_id = ?`,
      args: [documentId],
    })
  );

  const byId = new Map<string, ExistingChunk>();
  const missingHash: string[] = [];
  for (const row of result.rows) {
    const id = row.id as string;
    byId.set(id, {
      id,
      chunkIndex: row.chunk_index as number,
      contentHash: (row.content_hash as string | null) ?? "",
    });
    if (!row.content_hash) missingHash.push(id);
  }

  for (let i = 0; i < missingHash.length; i += HASH_BACKFILL_BATCH) {
    const ids = missingHash.slice(i, i + HASH_BACKFILL_BATCH);
    const placeholders = ids.map(() => "?").join(",");
    const textRows = await withRetry(`load ${table} texts`, () =>
      db.execute({
        sql: `SELECT id, text FROM ${table} WHERE id IN (${placeholders})`,
        args: ids,
      })
    );

    const updates = textRows.rows.map((row) => {
      const hash = hashChunk(row.text as string);
      byId.get(row.id as string)!.contentHash = hash;
      return {
        sql: `UPDATE ${table} SET content_hash = ? WHERE id = ?`,
        args: [hash, row.id as string],
      };
    });
    if (updates.length > 0) {
      await withRetry(`backfill ${table} hashes`, () => db.batch(updates, "write"));
    }
  }

  return [...byId.values()];
}

export function makeDeadline(ms: number): number {
  return Date.now() + ms;
}

/**
 * Cooperative per-file time budget, checked between network operations.
 * Incremental writes mean progress made before the deadline is kept, so the
 * next sync resumes where this one stopped instead of starting over.
 */
export function checkDeadline(deadline: number, label: string): void {
  if (Date.now() > deadline) {
    throw new Error(`File processing time budget exceeded while ${label} (progress is saved; next sync resumes)`);
  }
}
