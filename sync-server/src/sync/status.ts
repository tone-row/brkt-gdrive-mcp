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

// ============================================
// V2 Table Helpers (dual-write for progress UI)
// ============================================

/**
 * Initialize V2 sync state for discovery phase
 */
async function initV2SyncState(userId: string): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO user_sync_state (
              user_id, status, worker_heartbeat_at, started_at,
              total_files_discovered, files_processed, files_failed
            ) VALUES (?, 'discovering', datetime('now'), datetime('now'), 0, 0, 0)
            ON CONFLICT(user_id) DO UPDATE SET
              status = 'discovering',
              worker_heartbeat_at = datetime('now'),
              started_at = datetime('now'),
              total_files_discovered = 0,
              files_processed = 0,
              files_failed = 0,
              completed_at = NULL,
              error = NULL`,
      args: [userId],
    });
  } catch (e) {
    // V2 table might not exist, ignore
  }
}

/**
 * Update V2 sync state to processing phase with file count
 */
export async function setV2Processing(userId: string, totalFiles: number): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE user_sync_state SET
              status = 'processing',
              total_files_discovered = ?,
              worker_heartbeat_at = datetime('now')
            WHERE user_id = ?`,
      args: [totalFiles, userId],
    });
  } catch (e) {
    // V2 table might not exist, ignore
  }
}

/**
 * Update V2 progress counters
 */
export async function updateV2Progress(
  userId: string,
  filesProcessed: number,
  filesFailed: number
): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE user_sync_state SET
              files_processed = ?,
              files_failed = ?,
              worker_heartbeat_at = datetime('now')
            WHERE user_id = ?`,
      args: [filesProcessed, filesFailed, userId],
    });
  } catch (e) {
    // V2 table might not exist, ignore
  }
}

/**
 * Mark V2 sync as completed
 */
async function completeV2SyncState(
  userId: string,
  result: { added: number; updated: number; deleted: number }
): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE user_sync_state SET
              status = 'completed',
              completed_at = datetime('now'),
              last_result = ?,
              error = NULL
            WHERE user_id = ?`,
      args: [JSON.stringify(result), userId],
    });
  } catch (e) {
    // V2 table might not exist, ignore
  }
}

/**
 * Mark V2 sync as failed
 */
async function failV2SyncState(userId: string, error: string): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE user_sync_state SET
              status = 'failed',
              completed_at = datetime('now'),
              error = ?
            WHERE user_id = ?`,
      args: [error, userId],
    });
  } catch (e) {
    // V2 table might not exist, ignore
  }
}

// ============================================
// File Jobs Helpers (for progress UI)
// ============================================

/**
 * Clear all file jobs for a user before starting sync
 */
export async function clearFileJobs(userId: string): Promise<void> {
  try {
    await db.execute({
      sql: `DELETE FROM file_jobs WHERE user_id = ?`,
      args: [userId],
    });
  } catch (e) {
    // Table might not exist, ignore
  }
}

/**
 * Create file jobs for all files to be processed
 */
export async function createFileJobs(
  userId: string,
  files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string }>
): Promise<void> {
  try {
    for (const file of files) {
      await db.execute({
        sql: `INSERT INTO file_jobs (
                id, user_id, google_file_id, file_name, mime_type, modified_time, status
              ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
              ON CONFLICT(user_id, google_file_id) DO UPDATE SET
                file_name = excluded.file_name,
                status = 'pending',
                error = NULL,
                completed_at = NULL`,
        args: [
          crypto.randomUUID(),
          userId,
          file.id,
          file.name,
          file.mimeType,
          file.modifiedTime,
        ],
      });
    }
  } catch (e) {
    // Table might not exist, ignore
  }
}

/**
 * Mark a file job as processing
 */
export async function markFileProcessing(userId: string, googleFileId: string): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE file_jobs SET status = 'processing', claimed_at = datetime('now')
            WHERE user_id = ? AND google_file_id = ?`,
      args: [userId, googleFileId],
    });
  } catch (e) {
    // Table might not exist, ignore
  }
}

/**
 * Mark a file job as completed
 */
export async function markFileCompleted(userId: string, googleFileId: string): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE file_jobs SET status = 'completed', completed_at = datetime('now')
            WHERE user_id = ? AND google_file_id = ?`,
      args: [userId, googleFileId],
    });
  } catch (e) {
    // Table might not exist, ignore
  }
}

/**
 * Mark a file job as failed
 */
export async function markFileFailed(userId: string, googleFileId: string, error: string): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE file_jobs SET status = 'failed', completed_at = datetime('now'), error = ?
            WHERE user_id = ? AND google_file_id = ?`,
      args: [error, userId, googleFileId],
    });
  } catch (e) {
    // Table might not exist, ignore
  }
}

// If a sync has been running longer than this, consider it stale
// Note: Fly.io auto-stops machines after ~5 minutes of no active HTTP connections,
// so if sync takes longer than that, the machine gets killed and status stays "syncing".
// Setting this to 5 minutes allows users to retry sooner.
const SYNC_TIMEOUT_MINUTES = 5;

/**
 * Mark a sync as started. Returns false if a sync is already in progress.
 * If a sync has been running for more than SYNC_TIMEOUT_MINUTES, it's considered stale.
 */
export async function markSyncStarted(userId: string): Promise<boolean> {
  // Check if already syncing
  const existing = await getSyncStatus(userId);
  if (existing?.status === "syncing" && existing.startedAt) {
    const startedAt = new Date(existing.startedAt + "Z"); // Add Z for UTC
    const now = new Date();
    const minutesElapsed = (now.getTime() - startedAt.getTime()) / (1000 * 60);

    if (minutesElapsed < SYNC_TIMEOUT_MINUTES) {
      console.log(`  Sync already in progress for user ${userId} (started ${minutesElapsed.toFixed(1)} min ago)`);
      return false;
    } else {
      console.log(`  Stale sync detected (started ${minutesElapsed.toFixed(1)} min ago), allowing new sync`);
      // Mark the stale sync as failed before starting new one
      await markSyncFailed(userId, "Sync timed out (server may have restarted)");
    }
  }

  // Upsert the sync status (V1)
  await db.execute({
    sql: `INSERT INTO sync_status (user_id, status, started_at, error)
          VALUES (?, 'syncing', datetime('now'), NULL)
          ON CONFLICT(user_id) DO UPDATE SET
            status = 'syncing',
            started_at = datetime('now'),
            error = NULL`,
    args: [userId],
  });

  // Also initialize V2 sync state
  await initV2SyncState(userId);

  // Clear old file jobs
  await clearFileJobs(userId);

  return true;
}

/**
 * Mark a sync as completed successfully
 */
export async function markSyncCompleted(
  userId: string,
  result: { added: number; updated: number; deleted: number }
): Promise<void> {
  // V1
  await db.execute({
    sql: `UPDATE sync_status
          SET status = 'idle',
              completed_at = datetime('now'),
              last_result = ?,
              error = NULL
          WHERE user_id = ?`,
    args: [JSON.stringify(result), userId],
  });

  // V2
  await completeV2SyncState(userId, result);
}

/**
 * Mark a sync as failed
 */
export async function markSyncFailed(userId: string, error: string): Promise<void> {
  // V1
  await db.execute({
    sql: `UPDATE sync_status
          SET status = 'failed',
              completed_at = datetime('now'),
              error = ?
          WHERE user_id = ?`,
    args: [error, userId],
  });

  // V2
  await failV2SyncState(userId, error);
}
