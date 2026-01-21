import { createClient, Client } from "@libsql/client";

// Lazy initialization to avoid build-time errors when env vars aren't available
let _db: Client | null = null;

export const db = new Proxy({} as Client, {
  get(_target, prop) {
    if (!_db) {
      if (!process.env.TURSO_URL) {
        throw new Error("TURSO_URL environment variable is required");
      }
      _db = createClient({
        url: process.env.TURSO_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    }
    return (_db as any)[prop];
  },
});
