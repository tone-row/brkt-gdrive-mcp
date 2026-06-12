import { createClient } from "@libsql/client";

// Force the stateless HTTP transport (libsql:// prefers WebSocket, where a
// hung socket can stall a sync indefinitely) and bound every request so a
// stuck connection fails fast instead of hanging until the runtime timeout.
const TURSO_REQUEST_TIMEOUT_MS = 30_000;

const url = process.env.TURSO_URL!.replace(/^libsql:/, "https:");

export const db = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN,
  fetch: (input: any, init?: any) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(TURSO_REQUEST_TIMEOUT_MS) }),
});

/**
 * Retry a flaky network operation with backoff.
 * Callers must be idempotent: an ambiguous failure (e.g. timeout after the
 * server committed) re-runs the whole operation.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = 1000 * attempt;
        console.warn(`    [Retry] ${label} failed (attempt ${attempt}/${attempts}): ${error.message} — retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
