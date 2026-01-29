#!/usr/bin/env bun
/**
 * Rollback Phase 2: Clear all migrated data from new tables.
 *
 * This script deletes data from new tables but keeps the table structures.
 * Use this if you need to re-run the Phase 2 migration.
 *
 * WARNING: This will permanently delete all data in the new tables!
 *
 * Usage:
 *   bun scripts/migration/rollback-phase2.ts
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
  console.log("Rollback Phase 2: Clear migrated data from new tables\n");

  const tablesToClear = [
    "document_vectors",
    "user_document_access",
    "documents_v2",
    "file_jobs",
    "user_sync_state",
  ];

  // Show current state
  console.log("Current data in new tables:");

  for (const table of tablesToClear) {
    try {
      const countResult = await db.execute(`SELECT COUNT(*) as count FROM ${table}`);
      console.log(`  ${table}: ${countResult.rows[0]?.count} rows`);
    } catch {
      console.log(`  ${table}: (table does not exist)`);
    }
  }

  // Confirm
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("\nDelete all this data? (yes/no): ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "yes") {
    console.log("Aborted.");
    return;
  }

  console.log("\nClearing tables...\n");

  // Delete in order (respecting foreign key dependencies)
  for (const table of tablesToClear) {
    try {
      const result = await db.execute(`DELETE FROM ${table}`);
      console.log(`  ✓ Cleared ${table}: ${result.rowsAffected} rows deleted`);
    } catch (err: any) {
      console.log(`  ✗ Failed to clear ${table}: ${err.message}`);
    }
  }

  console.log("\n✅ Rollback complete.");
  console.log("\nThe new tables are now empty. You can re-run phase2-migrate-data.ts");
  console.log("Note: The old tables (documents, chunks, sync_status) are unchanged.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
