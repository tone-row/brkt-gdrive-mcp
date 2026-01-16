import { sync } from "./sync";

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

    // Sync endpoint
    if (url.pathname === "/sync" && (request.method === "POST" || request.method === "GET")) {
      // Verify authorization
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
        console.log(`Unauthorized sync request from ${request.headers.get("x-forwarded-for") || "unknown"}`);
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log(`\n${"=".repeat(50)}`);
      console.log(`Sync triggered at ${new Date().toISOString()}`);
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

    // 404 for unknown routes
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`Sync server running on http://localhost:${PORT}`);
console.log("Endpoints:");
console.log("  GET  /        - Health check");
console.log("  GET  /health  - Health check");
console.log("  POST /sync    - Trigger sync (requires Authorization header)");
