import { createClient } from "@libsql/client";

// Only create the client if the URL is available (won't be during build)
export const db = createClient({
  url: process.env.TURSO_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});
