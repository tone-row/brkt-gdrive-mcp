#!/usr/bin/env bun
/**
 * Force re-index all documents by resetting their timestamps.
 *
 * This sets google_modified_time to a placeholder value, which causes
 * the next sync to treat all documents as needing re-indexing.
 *
 * Usage:
 *   cd www && bun ../scripts/force-reindex.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";

async function main() {
  // Get current state
  const before = await db.execute(`
    SELECT COUNT(*) as doc_count,
           (SELECT COUNT(*) FROM chunks) as chunk_count
    FROM documents
  `);

  console.log("Current state:");
  console.log(`  ${before.rows[0]?.doc_count} documents`);
  console.log(`  ${before.rows[0]?.chunk_count} chunks\n`);

  // Confirm
  console.log("This will reset ALL document timestamps to force a complete re-index.");
  console.log("The next sync will:");
  console.log("  1. Delete all existing chunks");
  console.log("  2. Re-fetch and re-index every document from Google Drive");
  console.log("  3. Regenerate all embeddings\n");

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("Continue? (yes/no): ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "yes") {
    console.log("Aborted.");
    return;
  }

  // Reset all timestamps
  const result = await db.execute({
    sql: `UPDATE documents SET google_modified_time = ?`,
    args: [PLACEHOLDER_TIME],
  });

  console.log(`\n✅ Reset ${result.rowsAffected} document timestamps.`);
  console.log("\nNow trigger a sync from the dashboard or run:");
  console.log("  curl -X POST https://brkt-gdrive-sync.fly.dev/sync -H 'Authorization: Bearer <CRON_SECRET>'");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
