#!/usr/bin/env bun
/**
 * Reconcile the V2 tables (documents_v2 / document_vectors /
 * user_document_access) against V1 — the serving source of truth.
 *
 * Dual-write failures (e.g. timeouts) leave V2 stale until the doc's next
 * edit. This script finds docs where V2 is missing, older, or has a vector
 * count mismatch, and rebuilds them by copying chunks server-side in SQL
 * (INSERT ... SELECT — embeddings are never regenerated or transferred).
 *
 * V1 tables are strictly read-only here.
 *
 * Usage:
 *   bun scripts/reconcile-v2.ts            # dry run, reports what would change
 *   bun scripts/reconcile-v2.ts --apply    # actually write
 */

import { createClient } from "@libsql/client";

const APPLY = process.argv.includes("--apply");
const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";

const db = createClient({
  url: process.env.TURSO_URL!.replace(/^libsql:/, "https:"),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log(`Mode: ${APPLY ? "APPLY" : "dry run"}\n`);

// Canonical V1 copy per google_doc_id: the newest fully-indexed one
const canonical = await db.execute(`
  SELECT d.google_doc_id, d.id as v1_doc_id, d.title, d.google_modified_time,
         (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) as v1_chunks
  FROM documents d
  WHERE d.google_modified_time != '${PLACEHOLDER_TIME}'
    AND d.google_modified_time = (
      SELECT MAX(d2.google_modified_time) FROM documents d2
      WHERE d2.google_doc_id = d.google_doc_id
        AND d2.google_modified_time != '${PLACEHOLDER_TIME}'
    )
  GROUP BY d.google_doc_id
`);

const v2docs = await db.execute(`
  SELECT v2.google_doc_id, v2.id as v2_id, v2.google_modified_time,
         (SELECT COUNT(*) FROM document_vectors dv WHERE dv.document_id = v2.id) as v2_vectors
  FROM documents_v2 v2
`);
const v2ByGoogleId = new Map(v2docs.rows.map((r) => [r.google_doc_id as string, r]));

let missing = 0, stale = 0, countMismatch = 0, ok = 0, rebuilt = 0;

for (const row of canonical.rows) {
  const googleDocId = row.google_doc_id as string;
  const v1DocId = row.v1_doc_id as string;
  const v1Mod = row.google_modified_time as string;
  const v1Chunks = Number(row.v1_chunks);
  const v2 = v2ByGoogleId.get(googleDocId);

  let reason: string | null = null;
  if (!v2) {
    reason = "missing in V2";
    missing++;
  } else if ((v2.google_modified_time as string) < v1Mod) {
    reason = `V2 older (${v2.google_modified_time} < ${v1Mod})`;
    stale++;
  } else if (Number(v2.v2_vectors) !== v1Chunks) {
    reason = `vector count mismatch (V2 ${v2.v2_vectors} != V1 ${v1Chunks})`;
    countMismatch++;
  } else {
    ok++;
    continue;
  }

  console.log(`  ${row.title} — ${reason}`);
  if (!APPLY) continue;

  let v2Id = v2?.v2_id as string | undefined;
  if (!v2Id) {
    v2Id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO documents_v2 (id, google_doc_id, title, full_text, google_modified_time)
            SELECT ?, google_doc_id, title, full_text, '${PLACEHOLDER_TIME}'
            FROM documents WHERE id = ?`,
      args: [v2Id, v1DocId],
    });
  }

  // Rebuild vectors as a pure server-side copy of the canonical V1 chunks
  await db.execute({ sql: `DELETE FROM document_vectors WHERE document_id = ?`, args: [v2Id] });
  await db.execute({
    sql: `INSERT INTO document_vectors (id, document_id, chunk_index, text, content_hash, embedding)
          SELECT lower(hex(randomblob(16))), ?, chunk_index, text, content_hash, embedding
          FROM chunks WHERE document_id = ?`,
    args: [v2Id, v1DocId],
  });

  // Bump doc metadata last (crash-safe ordering: re-run converges)
  await db.execute({
    sql: `UPDATE documents_v2 SET title = (SELECT title FROM documents WHERE id = ?),
            full_text = (SELECT full_text FROM documents WHERE id = ?),
            google_modified_time = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [v1DocId, v1DocId, v1Mod, v2Id],
  });
  rebuilt++;
}

// Missing access rows for every (user, doc) pair present in V1
const missingAccess = await db.execute(`
  SELECT DISTINCT d.user_id, v2.id as doc_v2_id
  FROM documents d
  JOIN documents_v2 v2 ON v2.google_doc_id = d.google_doc_id
  LEFT JOIN user_document_access uda
    ON uda.user_id = d.user_id AND uda.document_id = v2.id
  WHERE uda.id IS NULL
`);
console.log(`\nMissing access rows: ${missingAccess.rows.length}`);
if (APPLY) {
  for (const row of missingAccess.rows) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO user_document_access (id, user_id, document_id, first_seen_at, last_verified_at)
            VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      args: [crypto.randomUUID(), row.user_id as string, row.doc_v2_id as string],
    });
  }
}

// Orphans: V2 docs nobody has access to (report only — cleanup is a separate decision)
const orphans = await db.execute(`
  SELECT COUNT(*) as n FROM documents_v2 v2
  WHERE NOT EXISTS (SELECT 1 FROM user_document_access uda WHERE uda.document_id = v2.id)
`);

console.log(`\nSummary: ${ok} in sync, ${missing} missing, ${stale} stale, ${countMismatch} count-mismatched`);
if (APPLY) console.log(`Rebuilt: ${rebuilt}, access rows added: ${missingAccess.rows.length}`);
console.log(`Orphaned V2 docs (no access rows, reported only): ${orphans.rows[0]!.n}`);

// --check (CI guardrail): exit nonzero on drift so a scheduled dry run fails
// loudly. Orphans are excluded — they're report-only by design.
if (process.argv.includes("--check")) {
  const drift = missing + stale + countMismatch + missingAccess.rows.length;
  if (drift > 0 && !APPLY) {
    console.error(`\nDrift detected (${drift} item(s)) — run with --apply to heal.`);
    process.exit(2);
  }
}
process.exit(0);
