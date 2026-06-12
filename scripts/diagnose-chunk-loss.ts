/**
 * Read-only diagnostic for the chunk-loss investigation.
 * Usage: bun run scripts/diagnose-chunk-loss.ts
 * Reads TURSO_URL / TURSO_AUTH_TOKEN from env (loaded from .env.local).
 */
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function q(label: string, sql: string, args: any[] = []) {
  try {
    const r = await db.execute({ sql, args });
    console.log(`\n=== ${label} ===`);
    console.table(r.rows.map((row) => ({ ...row })));
  } catch (e: any) {
    console.log(`\n=== ${label} === ERROR: ${e.message}`);
  }
}

await q("Users / doc / chunk counts", `
  SELECT u.email,
         (SELECT COUNT(*) FROM documents d WHERE d.user_id = u.id) AS docs,
         (SELECT COUNT(*) FROM chunks c WHERE c.user_id = u.id) AS chunks
  FROM users u ORDER BY chunks DESC`);

await q("Docs with ZERO chunks (chunk-loss victims)", `
  SELECT d.user_id, d.title, LENGTH(d.full_text) AS text_len, d.google_modified_time, d.updated_at
  FROM documents d
  WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
  ORDER BY text_len DESC LIMIT 30`);

await q("Docs with placeholder timestamp (partial index)", `
  SELECT user_id, title, LENGTH(full_text) AS text_len, created_at, updated_at
  FROM documents WHERE google_modified_time = '1970-01-01T00:00:00.000Z'
  ORDER BY text_len DESC LIMIT 30`);

await q("Largest docs by text length + chunk counts", `
  SELECT d.title, LENGTH(d.full_text) AS text_len,
         (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunks,
         d.google_modified_time, d.updated_at
  FROM documents d ORDER BY text_len DESC LIMIT 15`);

await q("file_jobs status distribution", `
  SELECT status, COUNT(*) AS n FROM file_jobs GROUP BY status`);

await q("file_jobs recent failures", `
  SELECT file_name, status, error, completed_at, retry_count
  FROM file_jobs WHERE status IN ('failed') ORDER BY completed_at DESC LIMIT 30`);

await q("file_jobs stuck in processing", `
  SELECT file_name, claimed_at, retry_count FROM file_jobs WHERE status = 'processing' ORDER BY claimed_at DESC LIMIT 15`);

await q("sync_status (V1)", `SELECT * FROM sync_status`);

await q("user_sync_state (V2)", `
  SELECT user_id, status, worker_heartbeat_at, total_files_discovered, files_processed, files_failed, started_at, completed_at, error
  FROM user_sync_state`);

await q("V2 vector counts", `
  SELECT (SELECT COUNT(*) FROM documents_v2) AS docs_v2,
         (SELECT COUNT(*) FROM document_vectors) AS vectors,
         (SELECT COUNT(*) FROM user_document_access) AS access_rows`);

process.exit(0);
