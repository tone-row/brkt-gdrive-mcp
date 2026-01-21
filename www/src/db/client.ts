import { createClient, Client } from "@libsql/client";

// Lazy initialization to avoid build-time errors when env vars aren't available
let _db: Client | null = null;

function getDb(): Client {
  if (!_db) {
    if (!process.env.TURSO_URL) {
      throw new Error("TURSO_URL environment variable is required");
    }
    _db = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _db;
}

// Export wrapper that lazily initializes the client
// Using explicit method delegation instead of Proxy to avoid issues with private fields
export const db = {
  execute: (...args: Parameters<Client["execute"]>) => getDb().execute(...args),
  batch: (...args: Parameters<Client["batch"]>) => getDb().batch(...args),
  transaction: (...args: Parameters<Client["transaction"]>) => getDb().transaction(...args),
  executeMultiple: (...args: Parameters<Client["executeMultiple"]>) => getDb().executeMultiple(...args),
  sync: () => getDb().sync(),
  close: () => getDb().close(),
};
