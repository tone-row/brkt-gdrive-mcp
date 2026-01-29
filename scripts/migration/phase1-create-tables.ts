#!/usr/bin/env bun
/**
 * Phase 1: Create new tables for the sync architecture migration.
 *
 * This script creates the new tables without modifying existing ones.
 * Safe to run multiple times (uses IF NOT EXISTS).
 *
 * Usage:
 *   bun scripts/migration/phase1-create-tables.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log("Phase 1: Creating new sync architecture tables...\n");

  // 1. Enhanced sync state tracking with heartbeat
  console.log("Creating user_sync_state table...");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_sync_state (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      worker_id TEXT,
      worker_heartbeat_at TEXT,
      total_files_discovered INTEGER DEFAULT 0,
      files_processed INTEGER DEFAULT 0,
      files_failed INTEGER DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      last_result TEXT,
      error TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 2. Per-file job queue for resumable processing
  console.log("Creating file_jobs table...");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS file_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      google_file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      modified_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      error TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, google_file_id)
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_file_jobs_user_status ON file_jobs(user_id, status)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_file_jobs_claimed ON file_jobs(status, claimed_at)
  `);

  // 3. Deduplicated documents (global, not per-user)
  console.log("Creating documents_v2 table...");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS documents_v2 (
      id TEXT PRIMARY KEY,
      google_doc_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      full_text TEXT NOT NULL,
      google_modified_time TEXT NOT NULL,
      content_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_documents_v2_google_id ON documents_v2(google_doc_id)
  `);

  // 4. User-document access mapping (many-to-many)
  console.log("Creating user_document_access table...");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_document_access (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_verified_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents_v2(id) ON DELETE CASCADE,
      UNIQUE(user_id, document_id)
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_user_doc_access_user ON user_document_access(user_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_user_doc_access_doc ON user_document_access(document_id)
  `);

  // 5. Deduplicated chunks with vector embeddings
  console.log("Creating document_vectors table...");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS document_vectors (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      content_hash TEXT,
      embedding F32_BLOB(1536),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents_v2(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS document_vectors_embedding_idx ON document_vectors(libsql_vector_idx(embedding))
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_document_vectors_doc ON document_vectors(document_id)
  `);

  console.log("\nPhase 1 complete. Verifying tables...\n");

  // Verify tables were created
  const newTables = [
    "user_sync_state",
    "file_jobs",
    "documents_v2",
    "user_document_access",
    "document_vectors",
  ];

  for (const table of newTables) {
    const result = await db.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      args: [table],
    });

    if (result.rows.length > 0) {
      console.log(`  ✓ ${table}`);
    } else {
      console.log(`  ✗ ${table} (MISSING)`);
    }
  }

  // Show index status
  console.log("\nVerifying indexes...\n");
  const indexes = [
    "idx_file_jobs_user_status",
    "idx_file_jobs_claimed",
    "idx_documents_v2_google_id",
    "idx_user_doc_access_user",
    "idx_user_doc_access_doc",
    "document_vectors_embedding_idx",
    "idx_document_vectors_doc",
  ];

  for (const idx of indexes) {
    const result = await db.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
      args: [idx],
    });

    if (result.rows.length > 0) {
      console.log(`  ✓ ${idx}`);
    } else {
      console.log(`  ✗ ${idx} (MISSING)`);
    }
  }

  console.log("\n✅ Phase 1 migration complete.");
  console.log("\nNext steps:");
  console.log("  1. Run phase2-migrate-data.ts to copy existing data");
  console.log("  2. Run verify-migration.ts to validate the migration");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
