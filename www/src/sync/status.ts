import { db } from "../db/client";

export interface SyncStatus {
  userId: string;
  status: "idle" | "syncing" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  lastResult: { added: number; updated: number; deleted: number } | null;
  error: string | null;
}

// If a sync has been running longer than this, consider it stale.
// Fly.io auto-stops machines after ~5 minutes of no HTTP activity.
const SYNC_TIMEOUT_MINUTES = 5;

/**
 * Mark a sync as failed
 */
export async function markSyncFailed(userId: string, error: string): Promise<void> {
  await db.execute({
    sql: `UPDATE sync_status
          SET status = 'failed',
              completed_at = datetime('now'),
              error = ?
          WHERE user_id = ?`,
    args: [error, userId],
  });
}

/**
 * Get the sync status for a user.
 * Automatically detects and resets stale syncs (syncing for > SYNC_TIMEOUT_MINUTES).
 */
export async function getSyncStatus(userId: string): Promise<SyncStatus | null> {
  const result = await db.execute({
    sql: "SELECT * FROM sync_status WHERE user_id = ?",
    args: [userId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  const status = row.status as "idle" | "syncing" | "failed";
  const startedAt = row.started_at as string | null;

  // Auto-detect and reset stale syncs
  if (status === "syncing" && startedAt) {
    const startedAtDate = new Date(startedAt + "Z"); // Add Z for UTC
    const now = new Date();
    const minutesElapsed = (now.getTime() - startedAtDate.getTime()) / (1000 * 60);

    if (minutesElapsed >= SYNC_TIMEOUT_MINUTES) {
      console.log(`Auto-resetting stale sync for user ${userId} (started ${minutesElapsed.toFixed(1)} min ago)`);
      await markSyncFailed(userId, "Sync timed out (server may have stopped)");
      // Return the updated status
      return {
        userId: row.user_id as string,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        lastResult: row.last_result ? JSON.parse(row.last_result as string) : null,
        error: "Sync timed out (server may have stopped)",
      };
    }
  }

  return {
    userId: row.user_id as string,
    status,
    startedAt,
    completedAt: row.completed_at as string | null,
    lastResult: row.last_result ? JSON.parse(row.last_result as string) : null,
    error: row.error as string | null,
  };
}

/**
 * Mark a sync as started. Returns false if a sync is already in progress.
 * If a sync has been running for more than SYNC_TIMEOUT_MINUTES, it's considered stale.
 */
export async function markSyncStarted(userId: string): Promise<boolean> {
  // Check if already syncing - getSyncStatus will auto-reset stale syncs
  const existing = await getSyncStatus(userId);

  // If still syncing after getSyncStatus check, it's a fresh sync in progress
  if (existing?.status === "syncing") {
    console.log(`  Sync already in progress for user ${userId}`);
    return false;
  }

  // Upsert the sync status
  await db.execute({
    sql: `INSERT INTO sync_status (user_id, status, started_at, error)
          VALUES (?, 'syncing', datetime('now'), NULL)
          ON CONFLICT(user_id) DO UPDATE SET
            status = 'syncing',
            started_at = datetime('now'),
            error = NULL`,
    args: [userId],
  });

  return true;
}

/**
 * Mark a sync as completed successfully
 */
export async function markSyncCompleted(
  userId: string,
  result: { added: number; updated: number; deleted: number }
): Promise<void> {
  await db.execute({
    sql: `UPDATE sync_status
          SET status = 'idle',
              completed_at = datetime('now'),
              last_result = ?,
              error = NULL
          WHERE user_id = ?`,
    args: [JSON.stringify(result), userId],
  });
}
