import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helper";
import { db } from "@/db/client";
import { getSyncStatus } from "@/sync/status";

// Feature flag to use V2 sync state table
const USE_V2_SYNC_STATE = process.env.USE_V2_SYNC_STATE === "true";

// Timeout for stale workers (2 minutes)
const WORKER_STALE_TIMEOUT_SECONDS = 120;

interface V2SyncStatus {
  status: "idle" | "discovering" | "processing" | "completed" | "failed";
  workerHeartbeatAt: string | null;
  totalFilesDiscovered: number;
  filesProcessed: number;
  filesFailed: number;
  startedAt: string | null;
  completedAt: string | null;
  lastResult: { added: number; updated: number; deleted: number } | null;
  error: string | null;
}

async function getV2SyncStatus(userId: string): Promise<V2SyncStatus | null> {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM user_sync_state WHERE user_id = ?`,
      args: [userId],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    let status = row.status as V2SyncStatus["status"];
    let error = row.error as string | null;
    const workerHeartbeatAt = row.worker_heartbeat_at as string | null;

    // Check for stale worker
    if ((status === "discovering" || status === "processing") && workerHeartbeatAt) {
      const heartbeat = new Date(workerHeartbeatAt + "Z");
      const now = new Date();
      const secondsElapsed = (now.getTime() - heartbeat.getTime()) / 1000;

      if (secondsElapsed >= WORKER_STALE_TIMEOUT_SECONDS) {
        // Worker is stale - report as failed
        status = "failed";
        error = "Sync timed out (worker stopped responding)";
      }
    }

    return {
      status,
      workerHeartbeatAt,
      totalFilesDiscovered: (row.total_files_discovered as number) || 0,
      filesProcessed: (row.files_processed as number) || 0,
      filesFailed: (row.files_failed as number) || 0,
      startedAt: row.started_at as string | null,
      completedAt: row.completed_at as string | null,
      lastResult: row.last_result ? JSON.parse(row.last_result as string) : null,
      error,
    };
  } catch {
    // Table might not exist yet
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user has Google account connected
    const accountResult = await db.execute({
      sql: `SELECT id, access_token FROM accounts WHERE user_id = ? AND provider_id = 'google'`,
      args: [user.id],
    });
    const hasGoogleAccount = accountResult.rows.length > 0;
    const hasValidToken = hasGoogleAccount && accountResult.rows[0]!.access_token;

    // Get document count
    const docResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM documents WHERE user_id = ?`,
      args: [user.id],
    });
    const documentCount = (docResult.rows[0]?.count as number) || 0;

    // Get chunk count
    const chunkResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM chunks WHERE user_id = ?`,
      args: [user.id],
    });
    const chunkCount = (chunkResult.rows[0]?.count as number) || 0;

    // User needs to reconnect if they have documents but no valid token
    const needsReconnect = !hasValidToken && documentCount > 0;

    // Get sync status from V2 table if enabled, otherwise use V1
    if (USE_V2_SYNC_STATE) {
      const v2Status = await getV2SyncStatus(user.id);

      // Map V2 status to a format compatible with V1
      let mappedStatus: "idle" | "syncing" | "failed" = "idle";
      if (v2Status) {
        if (v2Status.status === "discovering" || v2Status.status === "processing") {
          mappedStatus = "syncing";
        } else if (v2Status.status === "failed") {
          mappedStatus = "failed";
        }
      }

      return NextResponse.json({
        googleConnected: !!hasValidToken,
        needsReconnect,
        documentCount,
        chunkCount,
        syncStatus: v2Status ? {
          status: mappedStatus,
          startedAt: v2Status.startedAt,
          completedAt: v2Status.completedAt,
          lastResult: v2Status.lastResult,
          error: v2Status.error,
          // V2-specific fields
          progress: v2Status.totalFilesDiscovered > 0
            ? {
                totalFiles: v2Status.totalFilesDiscovered,
                filesProcessed: v2Status.filesProcessed,
                filesFailed: v2Status.filesFailed,
                percentComplete: Math.round(
                  (v2Status.filesProcessed / v2Status.totalFilesDiscovered) * 100
                ),
              }
            : null,
        } : null,
      });
    }

    // V1 path: use original sync_status table
    const syncStatus = await getSyncStatus(user.id);

    return NextResponse.json({
      googleConnected: !!hasValidToken,
      needsReconnect,
      documentCount,
      chunkCount,
      syncStatus: syncStatus ? {
        status: syncStatus.status,
        startedAt: syncStatus.startedAt,
        completedAt: syncStatus.completedAt,
        lastResult: syncStatus.lastResult,
        error: syncStatus.error,
      } : null,
    });
  } catch (error) {
    console.error("Status error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
