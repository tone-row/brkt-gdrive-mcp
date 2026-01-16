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

      try {
        const startTime = Date.now();
        const result = await sync();
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`Sync completed in ${duration}s`);

        return new Response(JSON.stringify({
          success: true,
          message: "Sync completed successfully",
          duration: `${duration}s`,
          ...result,
          timestamp: new Date().toISOString(),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error: any) {
        console.error(`Sync failed: ${error.message}`);
        console.error(error.stack);

        return new Response(JSON.stringify({
          success: false,
          error: "Sync failed",
          message: error.message,
          timestamp: new Date().toISOString(),
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Sync single user endpoint: POST /sync/:userId
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

      try {
        const startTime = Date.now();
        const result = await syncUserById(userId);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`User sync completed in ${duration}s`);

        // Check if sync was skipped because already in progress
        if (result.alreadySyncing) {
          return new Response(JSON.stringify({
            success: false,
            error: "Sync already in progress",
            message: "A sync is already running for this user. Please wait.",
            timestamp: new Date().toISOString(),
          }), {
            status: 409, // Conflict
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: "User sync completed successfully",
          duration: `${duration}s`,
          ...result,
          timestamp: new Date().toISOString(),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error: any) {
        console.error(`User sync failed: ${error.message}`);
        console.error(error.stack);

        return new Response(JSON.stringify({
          success: false,
          error: "Sync failed",
          message: error.message,
          timestamp: new Date().toISOString(),
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
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
