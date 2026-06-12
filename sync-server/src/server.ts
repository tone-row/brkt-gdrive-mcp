import { sync, syncUserById } from "./sync";

const CRON_SECRET = process.env.CRON_SECRET;
const PORT = process.env.PORT || 8080;

if (!CRON_SECRET) {
  console.error("CRON_SECRET environment variable is required");
  process.exit(1);
}

console.log(`Starting sync server on port ${PORT}...`);

// ============================================
// Built-in scheduler
// ============================================
// Scheduling lives here (the machine is always on: min_machines_running = 1)
// instead of GitHub Actions, whose cron is silently disabled after 60 days
// without repo activity — which is exactly what stopped all indexing between
// May 17 and June 12, 2026. The GH workflow remains as a manual fallback.
//
// The first run fires shortly after boot, so a machine restart (deploy, OOM)
// mid-sync self-heals: interrupted files resume on that catch-up run.
const SYNC_INTERVAL_HOURS = Number(process.env.SYNC_INTERVAL_HOURS ?? "8");
const INITIAL_SYNC_DELAY_MS = 5 * 60 * 1000;

let scheduledSyncRunning = false;

async function runScheduledSync(): Promise<void> {
  if (scheduledSyncRunning) {
    console.log("[Scheduler] Previous scheduled sync still running, skipping this tick");
    return;
  }
  scheduledSyncRunning = true;
  const startTime = Date.now();
  console.log(`[Scheduler] Starting scheduled sync at ${new Date().toISOString()}`);
  try {
    const result = await sync();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Scheduler] Scheduled sync completed in ${duration}s: +${result.totalAdded} added, ~${result.totalUpdated} updated, -${result.totalDeleted} deleted`);
  } catch (error: any) {
    console.error(`[Scheduler] Scheduled sync failed: ${error.message}`);
  } finally {
    scheduledSyncRunning = false;
  }
}

if (SYNC_INTERVAL_HOURS > 0) {
  console.log(`[Scheduler] Sync every ${SYNC_INTERVAL_HOURS}h; first run in ${INITIAL_SYNC_DELAY_MS / 60000} min`);
  setTimeout(() => {
    runScheduledSync();
    setInterval(runScheduledSync, SYNC_INTERVAL_HOURS * 60 * 60 * 1000);
  }, INITIAL_SYNC_DELAY_MS);
} else {
  console.log("[Scheduler] Disabled (SYNC_INTERVAL_HOURS=0)");
}

Bun.serve({
  port: Number(PORT),

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify authorization for all sync endpoints
    const authHeader = request.headers.get("Authorization");
    const isAuthorized = authHeader === `Bearer ${CRON_SECRET}`;

    // Sync all users endpoint
    if (url.pathname === "/sync" && (request.method === "POST" || request.method === "GET")) {
      if (!isAuthorized) {
        console.log(`Unauthorized sync request from ${request.headers.get("x-forwarded-for") || "unknown"}`);
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log(`\n${"=".repeat(50)}`);
      console.log(`Full sync triggered at ${new Date().toISOString()}`);
      console.log(`${"=".repeat(50)}`);

      // Start sync in background and return immediately
      // This prevents gateway timeouts from Fly.io proxy
      const startTime = Date.now();
      sync()
        .then((result) => {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`\nFull sync completed in ${duration}s`);
          console.log(`Total: +${result.totalAdded} added, ~${result.totalUpdated} updated, -${result.totalDeleted} deleted`);
          console.log(`Users: ${result.usersProcessed} processed, ${result.authFailures} auth failures`);
        })
        .catch((error) => {
          console.error(`Full sync failed: ${error.message}`);
          console.error(error.stack);
        });

      return new Response(JSON.stringify({
        success: true,
        message: "Sync started",
        timestamp: new Date().toISOString(),
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Sync single user endpoint: POST /sync/:userId
    // This endpoint returns immediately and runs sync in background
    const userSyncMatch = url.pathname.match(/^\/sync\/([^/]+)$/);
    if (userSyncMatch && request.method === "POST") {
      if (!isAuthorized) {
        console.log(`Unauthorized user sync request from ${request.headers.get("x-forwarded-for") || "unknown"}`);
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const userId = userSyncMatch[1]!;
      console.log(`\n${"=".repeat(50)}`);
      console.log(`User sync triggered for ${userId} at ${new Date().toISOString()}`);
      console.log(`${"=".repeat(50)}`);

      // Start sync in background and return immediately
      // The frontend will poll /api/me/status to check progress
      syncUserById(userId)
        .then((result) => {
          if (result.alreadySyncing) {
            console.log(`User sync skipped (already in progress)`);
          } else {
            console.log(`User sync completed: +${result.added} added, ~${result.updated} updated, -${result.deleted} deleted`);
          }
        })
        .catch((error) => {
          console.error(`User sync failed: ${error.message}`);
          console.error(error.stack);
        });

      return new Response(JSON.stringify({
        success: true,
        message: "Sync started",
        timestamp: new Date().toISOString(),
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 404 for unknown routes
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`Sync server running on http://localhost:${PORT}`);
console.log("Endpoints:");
console.log("  GET  /             - Health check");
console.log("  GET  /health       - Health check");
console.log("  POST /sync         - Sync all users (requires Authorization)");
console.log("  POST /sync/:userId - Sync single user (requires Authorization)");
