#!/usr/bin/env bun
/**
 * Reset stuck sync status to idle.
 *
 * Usage:
 *   cd www && bun ../scripts/reset-sync-status.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log("Checking sync status...\n");

  // Get all sync statuses
  const result = await db.execute("SELECT * FROM sync_status");

  if (result.rows.length === 0) {
    console.log("No sync status records found.");
    return;
  }

  console.log("Current sync statuses:");
  for (const row of result.rows) {
    const status = row.status as string;
    const userId = row.user_id as string;
    const startedAt = row.started_at as string;
    const error = row.error as string | null;

    const statusEmoji = status === "syncing" ? "🔄" : status === "failed" ? "❌" : "✅";
    console.log(`  ${statusEmoji} User ${userId.slice(0, 8)}... - ${status} (started: ${startedAt || "never"})`);
    if (error) {
      console.log(`     Error: ${error}`);
    }
  }

  // Reset stuck syncs
  const updated = await db.execute(`
    UPDATE sync_status
    SET status = 'idle',
        error = 'Manually reset via script',
        completed_at = datetime('now')
    WHERE status = 'syncing'
  `);

  if (updated.rowsAffected > 0) {
    console.log(`\n✅ Reset ${updated.rowsAffected} stuck sync(s) to idle.`);
  } else {
    console.log("\n✅ No stuck syncs found.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
