#!/usr/bin/env bun
/**
 * Phase 2: Migrate existing data to the new sync architecture tables.
 *
 * This script copies data from old tables to new tables:
 * - sync_status -> user_sync_state
 * - documents -> documents_v2 (deduplicated by google_doc_id)
 * - documents -> user_document_access (user mappings)
 * - chunks -> document_vectors (with embeddings)
 *
 * IMPORTANT: The old tables remain intact. This is additive only.
 *
 * Usage:
 *   bun scripts/migration/phase2-migrate-data.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";
import { v4 as uuid } from "uuid";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log("Phase 2: Migrating existing data to new tables...\n");

  // Step 1: Migrate sync_status -> user_sync_state
  console.log("Step 1: Migrating sync_status -> user_sync_state...");
  const syncStatusResult = await db.execute(`SELECT * FROM sync_status`);
  let syncMigrated = 0;

  for (const row of syncStatusResult.rows) {
    await db.execute({
      sql: `INSERT INTO user_sync_state (
              user_id, status, started_at, completed_at, last_result, error
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              status = excluded.status,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              last_result = excluded.last_result,
              error = excluded.error`,
      args: [
        row.user_id,
        row.status,
        row.started_at,
        row.completed_at,
        row.last_result,
        row.error,
      ],
    });
    syncMigrated++;
  }
  console.log(`  Migrated ${syncMigrated} sync status records\n`);

  // Step 2: Build mapping of google_doc_id -> documents (grouped)
  console.log("Step 2: Analyzing documents for deduplication...");
  const documentsResult = await db.execute(`
    SELECT id, user_id, google_doc_id, title, full_text, google_modified_time, created_at, updated_at
    FROM documents
    ORDER BY google_modified_time DESC
  `);

  // Group documents by google_doc_id
  const docsByGoogleId = new Map<string, Array<typeof documentsResult.rows[0]>>();
  for (const row of documentsResult.rows) {
    const googleDocId = row.google_doc_id as string;
    if (!docsByGoogleId.has(googleDocId)) {
      docsByGoogleId.set(googleDocId, []);
    }
    docsByGoogleId.get(googleDocId)!.push(row);
  }

  console.log(`  Found ${documentsResult.rows.length} documents`);
  console.log(`  Unique google_doc_ids: ${docsByGoogleId.size}`);

  const sharedDocs = [...docsByGoogleId.values()].filter((docs) => docs.length > 1);
  if (sharedDocs.length > 0) {
    console.log(`  Shared documents (same google_doc_id, multiple users): ${sharedDocs.length}`);
  }
  console.log("");

  // Step 3: Create documents_v2 entries and user_document_access mappings
  console.log("Step 3: Creating deduplicated documents and access mappings...");

  // Map from old document id -> new document id in documents_v2
  const oldToNewDocId = new Map<string, string>();
  let docsV2Created = 0;
  let accessMappingsCreated = 0;

  for (const [googleDocId, docs] of docsByGoogleId) {
    // Use the most recently modified version as the canonical document
    const canonical = docs.sort(
      (a, b) =>
        new Date(b.google_modified_time as string).getTime() -
        new Date(a.google_modified_time as string).getTime()
    )[0]!;

    const newDocId = uuid();

    // Create documents_v2 entry
    await db.execute({
      sql: `INSERT INTO documents_v2 (
              id, google_doc_id, title, full_text, google_modified_time, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(google_doc_id) DO UPDATE SET
              title = excluded.title,
              full_text = excluded.full_text,
              google_modified_time = excluded.google_modified_time,
              updated_at = excluded.updated_at`,
      args: [
        newDocId,
        googleDocId,
        canonical.title,
        canonical.full_text,
        canonical.google_modified_time,
        canonical.created_at,
        canonical.updated_at,
      ],
    });
    docsV2Created++;

    // Map all old document IDs to the new one
    for (const doc of docs) {
      oldToNewDocId.set(doc.id as string, newDocId);
    }

    // Create user_document_access entries for each user who has this document
    for (const doc of docs) {
      const accessId = uuid();
      await db.execute({
        sql: `INSERT INTO user_document_access (
                id, user_id, document_id, first_seen_at, last_verified_at
              ) VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT(user_id, document_id) DO UPDATE SET
                last_verified_at = datetime('now')`,
        args: [
          accessId,
          doc.user_id,
          newDocId,
          doc.created_at,
        ],
      });
      accessMappingsCreated++;
    }
  }

  console.log(`  Created ${docsV2Created} deduplicated documents`);
  console.log(`  Created ${accessMappingsCreated} user-document access mappings\n`);

  // Step 4: Copy chunks to document_vectors
  console.log("Step 4: Copying chunks to document_vectors...");
  console.log("  (This may take a while for large datasets...)\n");

  // Get chunk count first
  const chunkCountResult = await db.execute(`SELECT COUNT(*) as count FROM chunks`);
  const totalChunks = chunkCountResult.rows[0]?.count as number;
  console.log(`  Total chunks to migrate: ${totalChunks}`);

  // Process in batches to avoid memory issues
  const BATCH_SIZE = 100;
  let chunksMigrated = 0;
  let offset = 0;

  while (offset < totalChunks) {
    const chunksResult = await db.execute({
      sql: `SELECT id, document_id, chunk_index, text, embedding
            FROM chunks
            ORDER BY document_id, chunk_index
            LIMIT ? OFFSET ?`,
      args: [BATCH_SIZE, offset],
    });

    for (const row of chunksResult.rows) {
      const oldDocId = row.document_id as string;
      const newDocId = oldToNewDocId.get(oldDocId);

      if (!newDocId) {
        console.log(`  Warning: No mapping for document_id ${oldDocId}, skipping chunk`);
        continue;
      }

      const newChunkId = uuid();

      // Insert into document_vectors, copying the embedding blob directly
      if (row.embedding) {
        await db.execute({
          sql: `INSERT INTO document_vectors (
                  id, document_id, chunk_index, text, embedding
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING`,
          args: [
            newChunkId,
            newDocId,
            row.chunk_index,
            row.text,
            row.embedding, // Raw embedding blob
          ],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO document_vectors (
                  id, document_id, chunk_index, text
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT DO NOTHING`,
          args: [
            newChunkId,
            newDocId,
            row.chunk_index,
            row.text,
          ],
        });
      }

      chunksMigrated++;
    }

    offset += BATCH_SIZE;
    if (offset % 500 === 0) {
      console.log(`  Progress: ${Math.min(offset, totalChunks)}/${totalChunks} chunks`);
    }
  }

  console.log(`\n  Migrated ${chunksMigrated} chunks to document_vectors\n`);

  // Final summary
  console.log("✅ Phase 2 migration complete.\n");
  console.log("Summary:");
  console.log(`  - user_sync_state: ${syncMigrated} records`);
  console.log(`  - documents_v2: ${docsV2Created} documents (deduplicated)`);
  console.log(`  - user_document_access: ${accessMappingsCreated} mappings`);
  console.log(`  - document_vectors: ${chunksMigrated} chunks`);
  console.log("\nNext steps:");
  console.log("  1. Run verify-migration.ts to validate data integrity");
  console.log("  2. Deploy dual-write code (Phase 3)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
