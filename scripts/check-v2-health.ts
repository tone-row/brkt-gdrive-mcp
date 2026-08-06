#!/usr/bin/env bun
/**
 * Internal consistency check for the V2 tables (documents_v2 /
 * document_vectors / user_document_access) — the serving AND write-side
 * source of truth since Aug 2026 (V1 tables are frozen).
 *
 * Replaces the old reconcile-v2.ts, whose V1-vs-V2 comparison lost its
 * baseline when V1 writes were retired (and whose --apply mode would have
 * "healed" V2 back to stale V1 content — deliberately deleted).
 *
 * Invariants checked (drift → exit 2 with --check):
 *   1. No document stuck on the placeholder timestamp for > 2 days
 *      (indexing crashed and never converged — syncs should self-heal this
 *      within one cycle).
 *   2. No fully-indexed document with zero vectors (search hole).
 *   3. No vectors pointing at a missing documents_v2 row.
 *
 * Reported only (not drift):
 *   - Orphaned docs (zero access rows) — accumulate by design when users
 *     lose Drive access; cleanup is a separate decision.
 *
 * Usage:
 *   bun scripts/check-v2-health.ts            # report
 *   bun scripts/check-v2-health.ts --check    # exit 2 on any drift (CI)
 */

import { createClient } from "@libsql/client";

const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";

const db = createClient({
  url: process.env.TURSO_URL!.replace(/^libsql:/, "https:"),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const stuck = await db.execute(`
  SELECT id, title, created_at FROM documents_v2
  WHERE google_modified_time = '${PLACEHOLDER_TIME}'
    AND created_at < datetime('now', '-2 days')
`);

const vectorless = await db.execute(`
  SELECT d.id, d.title FROM documents_v2 d
  WHERE d.google_modified_time != '${PLACEHOLDER_TIME}'
    AND NOT EXISTS (SELECT 1 FROM document_vectors dv WHERE dv.document_id = d.id)
`);

const orphanVectors = await db.execute(`
  SELECT COUNT(*) as n FROM document_vectors dv
  WHERE NOT EXISTS (SELECT 1 FROM documents_v2 d WHERE d.id = dv.document_id)
`);

const orphanDocs = await db.execute(`
  SELECT COUNT(*) as n FROM documents_v2 d
  WHERE NOT EXISTS (SELECT 1 FROM user_document_access uda WHERE uda.document_id = d.id)
`);

const totals = await db.execute(`
  SELECT (SELECT COUNT(*) FROM documents_v2) as docs,
         (SELECT COUNT(*) FROM document_vectors) as vectors,
         (SELECT COUNT(*) FROM user_document_access) as access_rows
`);

for (const r of stuck.rows) {
  console.log(`  STUCK placeholder since ${r.created_at}: ${r.title} (${r.id})`);
}
for (const r of vectorless.rows) {
  console.log(`  NO VECTORS: ${r.title} (${r.id})`);
}

const t = totals.rows[0]!;
console.log(`\nTotals: ${t.docs} docs, ${t.vectors} vectors, ${t.access_rows} access rows`);
console.log(
  `Summary: ${stuck.rows.length} stuck-placeholder, ${vectorless.rows.length} vector-less, ` +
  `${orphanVectors.rows[0]!.n} orphan vectors`
);
console.log(`Orphaned V2 docs (no access rows, reported only): ${orphanDocs.rows[0]!.n}`);

if (process.argv.includes("--check")) {
  const drift =
    stuck.rows.length + vectorless.rows.length + Number(orphanVectors.rows[0]!.n);
  if (drift > 0) {
    console.error(`\nDrift detected (${drift} item(s)).`);
    process.exit(2);
  }
}
process.exit(0);
