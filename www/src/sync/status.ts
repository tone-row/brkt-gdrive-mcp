import { db } from "../db/client";

export interface SyncStatus {
  userId: string;
  status: "idle" | "syncing" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  lastResult: { added: number; updated: number; deleted: number } | null;
  error: string | null;
}

/**
 * Get the sync status for a user
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
  return {
    userId: row.user_id as string,
    status: row.status as "idle" | "syncing" | "failed",
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
    lastResult: row.last_result ? JSON.parse(row.last_result as string) : null,
    error: row.error as string | null,
  };
}

/**
 * Mark a sync as started. Returns false if a sync is already in progress.
 */
export async function markSyncStarted(userId: string): Promise<boolean> {
  // Check if already syncing
  const existing = await getSyncStatus(userId);
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
