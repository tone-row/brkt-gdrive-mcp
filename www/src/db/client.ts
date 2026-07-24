import { createClient } from "@libsql/client";

// Force the stateless HTTP transport (libsql:// prefers WebSocket, where a
// hung socket can stall a request until the platform timeout) and bound every
// request so a slow query fails fast instead of grinding on server-side after
// the client has given up — abandoned queries are what saturate the DB during
// retry pile-ups. No retry wrapper on this read path: retries feed the pile-up.
const TURSO_REQUEST_TIMEOUT_MS = 25_000;

// Only create the client if the URL is available (won't be during build)
const url = (process.env.TURSO_URL || "file:local.db").replace(/^libsql:/, "https:");

export const db = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN,
  fetch: (input: any, init?: any) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(TURSO_REQUEST_TIMEOUT_MS) }),
});
