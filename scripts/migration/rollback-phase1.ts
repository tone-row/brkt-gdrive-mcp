#!/usr/bin/env bun
/**
 * Rollback Phase 1: Drop all new tables created for the sync architecture.
 *
 * This script removes the new tables without affecting existing data.
 * Use this if you need to completely undo the migration.
 *
 * WARNING: This will permanently delete all data in the new tables!
 *
 * Usage:
 *   bun scripts/migration/rollback-phase1.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";
import * as readline from "readline";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log("Rollback Phase 1: Drop new sync architecture tables\n");

  const tablesToDrop = [
    "document_vectors",
    "user_document_access",
    "documents_v2",
    "file_jobs",
    "user_sync_state",
  ];

  // Check what exists
  console.log("Tables to be dropped:");
  let hasData = false;

  for (const table of tablesToDrop) {
    const exists = await db.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      args: [table],
    });

    if (exists.rows.length > 0) {
      const countResult = await db.execute(`SELECT COUNT(*) as count FROM ${table}`);
      const count = countResult.rows[0]?.count as number;
      console.log(`  - ${table}: ${count} rows`);
      if (count > 0) hasData = true;
    } else {
      console.log(`  - ${table}: (does not exist)`);
    }
  }

  if (hasData) {
    console.log("\n⚠️  WARNING: Some tables contain data that will be permanently deleted!");
  }

  // Confirm
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("\nContinue with rollback? (yes/no): ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "yes") {
    console.log("Aborted.");
    return;
  }

  console.log("\nDropping tables...\n");

  // Drop tables in order (respecting foreign key dependencies)
  for (const table of tablesToDrop) {
    try {
      await db.execute(`DROP TABLE IF EXISTS ${table}`);
      console.log(`  ✓ Dropped ${table}`);
    } catch (err: any) {
      console.log(`  ✗ Failed to drop ${table}: ${err.message}`);
    }
  }

  console.log("\n✅ Rollback complete.");
  console.log("\nNote: The old tables (documents, chunks, sync_status) are unchanged.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
