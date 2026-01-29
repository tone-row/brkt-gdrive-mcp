/**
 * Job-based sync worker for the V2 sync architecture.
 *
 * This module implements a resumable, job-based sync pattern:
 * 1. Discovery phase: Populate file_jobs table with all files from Google Drive
 * 2. Processing phase: Claim and process jobs one at a time
 * 3. Heartbeat pattern: Keep worker alive and detect stale syncs
 *
 * Key features:
 * - Atomic job claiming (no double-processing)
 * - Heartbeat-based stale detection
 * - Progress tracking in user_sync_state
 * - Graceful recovery from worker crashes
 */

import { db } from "../db/client";
import { v4 as uuid } from "uuid";
import type { DriveDocument } from "./google-drive";

// Heartbeat interval: workers send heartbeat every 30 seconds
export const HEARTBEAT_INTERVAL_MS = 30_000;

// Heartbeat timeout: if no heartbeat for 2 minutes, worker is considered dead
export const HEARTBEAT_TIMEOUT_SECONDS = 120;

// Max retry count for failed jobs
export const MAX_RETRY_COUNT = 3;

export interface UserSyncState {
  userId: string;
  status: "idle" | "discovering" | "processing" | "completed" | "failed";
  workerId: string | null;
  workerHeartbeatAt: string | null;
  totalFilesDiscovered: number;
  filesProcessed: number;
  filesFailed: number;
  startedAt: string | null;
  completedAt: string | null;
  lastResult: { added: number; updated: number; deleted: number } | null;
  error: string | null;
}

export interface FileJob {
  id: string;
  userId: string;
  googleFileId: string;
  fileName: string;
  mimeType: string;
  modifiedTime: string;
  status: "pending" | "processing" | "completed" | "failed";
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  error: string | null;
  retryCount: number;
}

/**
 * Get the current sync state for a user from the V2 table.
 */
export async function getUserSyncState(userId: string): Promise<UserSyncState | null> {
  const result = await db.execute({
    sql: `SELECT * FROM user_sync_state WHERE user_id = ?`,
    args: [userId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  return {
    userId: row.user_id as string,
    status: row.status as UserSyncState["status"],
    workerId: row.worker_id as string | null,
    workerHeartbeatAt: row.worker_heartbeat_at as string | null,
    totalFilesDiscovered: (row.total_files_discovered as number) || 0,
    filesProcessed: (row.files_processed as number) || 0,
    filesFailed: (row.files_failed as number) || 0,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
    lastResult: row.last_result ? JSON.parse(row.last_result as string) : null,
    error: row.error as string | null,
  };
}

/**
 * Check if a worker is stale (no heartbeat for HEARTBEAT_TIMEOUT_SECONDS).
 */
function isWorkerStale(heartbeatAt: string | null): boolean {
  if (!heartbeatAt) return true;

  const heartbeat = new Date(heartbeatAt + "Z");
  const now = new Date();
  const secondsElapsed = (now.getTime() - heartbeat.getTime()) / 1000;

  return secondsElapsed >= HEARTBEAT_TIMEOUT_SECONDS;
}

/**
 * Claim or recover a sync for a user.
 *
 * Returns workerId if sync can proceed, null if another worker is active.
 */
export async function claimOrRecoverSync(userId: string): Promise<string | null> {
  const state = await getUserSyncState(userId);
  const workerId = uuid();

  if (!state) {
    // No existing state - create one and claim it
    await db.execute({
      sql: `INSERT INTO user_sync_state (
              user_id, status, worker_id, worker_heartbeat_at, started_at
            ) VALUES (?, 'discovering', ?, datetime('now'), datetime('now'))`,
      args: [userId, workerId],
    });
    return workerId;
  }

  if (state.status === "idle" || state.status === "completed" || state.status === "failed") {
    // Can start a new sync
    await db.execute({
      sql: `UPDATE user_sync_state SET
              status = 'discovering',
              worker_id = ?,
              worker_heartbeat_at = datetime('now'),
              total_files_discovered = 0,
              files_processed = 0,
              files_failed = 0,
              started_at = datetime('now'),
              completed_at = NULL,
              error = NULL
            WHERE user_id = ?`,
      args: [workerId, userId],
    });
    return workerId;
  }

  // Sync is in progress - check if worker is stale
  if (isWorkerStale(state.workerHeartbeatAt)) {
    console.log(`  [Worker] Recovering from stale worker (last heartbeat: ${state.workerHeartbeatAt})`);

    // Recover orphaned processing jobs
    await recoverOrphanedJobs(userId);

    // Take over the sync
    await db.execute({
      sql: `UPDATE user_sync_state SET
              worker_id = ?,
              worker_heartbeat_at = datetime('now'),
              error = NULL
            WHERE user_id = ?`,
      args: [workerId, userId],
    });
    return workerId;
  }

  // Another worker is actively processing
  console.log(`  [Worker] Another worker is active (heartbeat: ${state.workerHeartbeatAt})`);
  return null;
}

/**
 * Update the worker heartbeat timestamp.
 * Call this regularly during processing to prevent being marked as stale.
 */
export async function updateHeartbeat(userId: string, workerId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE user_sync_state
          SET worker_heartbeat_at = datetime('now')
          WHERE user_id = ? AND worker_id = ?`,
    args: [userId, workerId],
  });

  return result.rowsAffected > 0;
}

/**
 * Reset jobs that were claimed by a dead worker.
 */
export async function recoverOrphanedJobs(userId: string): Promise<number> {
  // Reset processing jobs that are older than the heartbeat timeout
  const result = await db.execute({
    sql: `UPDATE file_jobs
          SET status = 'pending',
              claimed_by = NULL,
              claimed_at = NULL,
              retry_count = retry_count + 1
          WHERE user_id = ?
            AND status = 'processing'
            AND claimed_at < datetime('now', '-${HEARTBEAT_TIMEOUT_SECONDS} seconds')
            AND retry_count < ?`,
    args: [userId, MAX_RETRY_COUNT],
  });

  if (result.rowsAffected > 0) {
    console.log(`  [Worker] Recovered ${result.rowsAffected} orphaned jobs`);
  }

  return result.rowsAffected;
}

/**
 * Populate the file_jobs table with files from Google Drive.
 * This is the "discovery" phase of sync.
 */
export async function populateFileJobs(
  userId: string,
  files: DriveDocument[]
): Promise<number> {
  let added = 0;

  for (const file of files) {
    // Upsert file job
    await db.execute({
      sql: `INSERT INTO file_jobs (
              id, user_id, google_file_id, file_name, mime_type, modified_time, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
            ON CONFLICT(user_id, google_file_id) DO UPDATE SET
              file_name = excluded.file_name,
              modified_time = excluded.modified_time,
              status = CASE
                WHEN file_jobs.modified_time < excluded.modified_time THEN 'pending'
                ELSE file_jobs.status
              END`,
      args: [uuid(), userId, file.id, file.name, file.mimeType, file.modifiedTime],
    });
    added++;
  }

  // Update discovery count
  await db.execute({
    sql: `UPDATE user_sync_state
          SET total_files_discovered = ?,
              status = 'processing'
          WHERE user_id = ?`,
    args: [files.length, userId],
  });

  return added;
}

/**
 * Atomically claim the next pending job for processing.
 * Returns null if no jobs are available.
 */
export async function claimNextJob(
  userId: string,
  workerId: string
): Promise<FileJob | null> {
  // Use a transaction to atomically claim a job
  const jobResult = await db.execute({
    sql: `SELECT id FROM file_jobs
          WHERE user_id = ? AND status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1`,
    args: [userId],
  });

  if (jobResult.rows.length === 0) {
    return null;
  }

  const jobId = jobResult.rows[0]!.id as string;

  // Atomically claim the job
  const claimResult = await db.execute({
    sql: `UPDATE file_jobs
          SET status = 'processing',
              claimed_by = ?,
              claimed_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
    args: [workerId, jobId],
  });

  if (claimResult.rowsAffected === 0) {
    // Another worker grabbed it first
    return null;
  }

  // Fetch the full job
  const fullJob = await db.execute({
    sql: `SELECT * FROM file_jobs WHERE id = ?`,
    args: [jobId],
  });

  if (fullJob.rows.length === 0) {
    return null;
  }

  const row = fullJob.rows[0]!;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    googleFileId: row.google_file_id as string,
    fileName: row.file_name as string,
    mimeType: row.mime_type as string,
    modifiedTime: row.modified_time as string,
    status: row.status as FileJob["status"],
    claimedBy: row.claimed_by as string | null,
    claimedAt: row.claimed_at as string | null,
    completedAt: row.completed_at as string | null,
    error: row.error as string | null,
    retryCount: (row.retry_count as number) || 0,
  };
}

/**
 * Mark a job as completed.
 */
export async function markJobCompleted(jobId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE file_jobs
          SET status = 'completed',
              completed_at = datetime('now'),
              error = NULL
          WHERE id = ?`,
    args: [jobId],
  });
}

/**
 * Mark a job as failed.
 */
export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await db.execute({
    sql: `UPDATE file_jobs
          SET status = 'failed',
              completed_at = datetime('now'),
              error = ?
          WHERE id = ?`,
    args: [error, jobId],
  });
}

/**
 * Update progress counters in user_sync_state.
 */
export async function updateProgress(
  userId: string,
  filesProcessed: number,
  filesFailed: number
): Promise<void> {
  await db.execute({
    sql: `UPDATE user_sync_state
          SET files_processed = ?,
              files_failed = ?
          WHERE user_id = ?`,
    args: [filesProcessed, filesFailed, userId],
  });
}

/**
 * Mark sync as completed.
 */
export async function markSyncCompletedV2(
  userId: string,
  result: { added: number; updated: number; deleted: number }
): Promise<void> {
  await db.execute({
    sql: `UPDATE user_sync_state
          SET status = 'completed',
              completed_at = datetime('now'),
              last_result = ?,
              worker_id = NULL
          WHERE user_id = ?`,
    args: [JSON.stringify(result), userId],
  });
}

/**
 * Mark sync as failed.
 */
export async function markSyncFailedV2(userId: string, error: string): Promise<void> {
  await db.execute({
    sql: `UPDATE user_sync_state
          SET status = 'failed',
              completed_at = datetime('now'),
              error = ?,
              worker_id = NULL
          WHERE user_id = ?`,
    args: [error, userId],
  });
}

/**
 * Get pending job count for a user.
 */
export async function getPendingJobCount(userId: string): Promise<number> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) as count FROM file_jobs WHERE user_id = ? AND status = 'pending'`,
    args: [userId],
  });
  return (result.rows[0]?.count as number) || 0;
}

/**
 * Get job statistics for a user.
 */
export async function getJobStats(userId: string): Promise<{
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}> {
  const result = await db.execute({
    sql: `SELECT status, COUNT(*) as count FROM file_jobs WHERE user_id = ? GROUP BY status`,
    args: [userId],
  });

  const stats = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };

  for (const row of result.rows) {
    const status = row.status as string;
    const count = row.count as number;
    stats.total += count;
    if (status === "pending") stats.pending = count;
    if (status === "processing") stats.processing = count;
    if (status === "completed") stats.completed = count;
    if (status === "failed") stats.failed = count;
  }

  return stats;
}

/**
 * Clear all file jobs for a user.
 * Call this at the start of a new sync to reset job state.
 */
export async function clearFileJobs(userId: string): Promise<void> {
  await db.execute({
    sql: `DELETE FROM file_jobs WHERE user_id = ?`,
    args: [userId],
  });
}

/**
 * Remove file jobs for documents that no longer exist in Google Drive.
 */
export async function removeStaleFileJobs(
  userId: string,
  currentGoogleFileIds: Set<string>
): Promise<number> {
  // Get all file jobs for this user
  const result = await db.execute({
    sql: `SELECT id, google_file_id FROM file_jobs WHERE user_id = ?`,
    args: [userId],
  });

  let removed = 0;
  for (const row of result.rows) {
    const googleFileId = row.google_file_id as string;
    if (!currentGoogleFileIds.has(googleFileId)) {
      await db.execute({
        sql: `DELETE FROM file_jobs WHERE id = ?`,
        args: [row.id],
      });
      removed++;
    }
  }

  return removed;
}
