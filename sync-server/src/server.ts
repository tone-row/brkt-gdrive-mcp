import { sync, syncUserById } from "./sync";

const CRON_SECRET = process.env.CRON_SECRET;
const PORT = process.env.PORT || 8080;

if (!CRON_SECRET) {
  console.error("CRON_SECRET environment variable is required");
  process.exit(1);
}

console.log(`Starting sync server on port ${PORT}...`);

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
