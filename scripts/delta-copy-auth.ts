/**
 * Delta-copy of small mutable auth tables from the OLD database to the NEW
 * one during a DB cutover.
 *
 * Context: during a rebuild-into-fresh-DB cutover, the sync-server is frozen
 * but the www app keeps writing auth rows (sessions, Google OAuth token
 * refreshes into accounts, OAuth access-token rotations, new users/api keys)
 * to the OLD database until the Vercel env swap completes. Run this
 * immediately after the new deployment starts serving to carry those rows
 * over. Without it, a lost OAuth rotation forces connected MCP clients into
 * invalid_grant re-auth, and a lost Google refresh token makes that user's
 * sync silently auth-fail.
 *
 * Semantics:
 * - Tables are copied whole (they are all tiny); correctness comes from the
 *   upsert guard, not from delta filtering.
 * - Rows with new PKs insert plainly.
 * - Rows that exist on BOTH sides update only if the source row's guard
 *   column (updated_at/updatedAt/last_used_at/...) is strictly newer than
 *   the target's — a row already refreshed on the NEW db must never be
 *   regressed to the old db's version.
 * - Guard column is resolved per table from PRAGMA table_info (Better Auth
 *   column names vary by config); tables without any timestamp column fall
 *   back to INSERT OR IGNORE (add missing rows, never overwrite).
 *
 * Usage:
 *   SOURCE_TURSO_URL=... SOURCE_TURSO_AUTH_TOKEN=... \
 *   TARGET_TURSO_URL=... TARGET_TURSO_AUTH_TOKEN=... \
 *   bun scripts/delta-copy-auth.ts [--apply]
 *
 * Default is a dry run that reports what would be copied.
 */
import { createClient, type Client } from "@libsql/client";

const APPLY = process.argv.includes("--apply");

const AUTH_TABLES = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "api_keys",
  "oauth_access_tokens",
  "oauth_authorization_codes",
  "oauth_clients",
  "oauth_registered_clients",
  "google_connections",
];

// Preference order: a true "modified" timestamp beats usage/creation stamps.
const GUARD_CANDIDATES = [
  "updated_at",
  "updatedAt",
  "last_used_at",
  "lastUsedAt",
  "created_at",
  "createdAt",
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function makeClient(url: string, authToken: string): Client {
  return createClient({
    url: url.replace(/^libsql:/, "https:"),
    authToken,
    fetch: (input: any, init?: any) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
  });
}

const source = makeClient(
  requireEnv("SOURCE_TURSO_URL"),
  requireEnv("SOURCE_TURSO_AUTH_TOKEN")
);
const target = makeClient(
  requireEnv("TARGET_TURSO_URL"),
  requireEnv("TARGET_TURSO_AUTH_TOKEN")
);

// Refuse to run against the same database on both sides.
const sourceHost = new URL(requireEnv("SOURCE_TURSO_URL").replace(/^libsql:/, "https:")).host;
const targetHost = new URL(requireEnv("TARGET_TURSO_URL").replace(/^libsql:/, "https:")).host;
if (sourceHost === targetHost) {
  console.error(`SOURCE and TARGET are the same database (${sourceHost}) — aborting.`);
  process.exit(1);
}

console.log(`Delta-copy auth tables: ${sourceHost} -> ${targetHost}`);
console.log(`Mode: ${APPLY ? "APPLY" : "dry run"}\n`);

interface TableInfo {
  columns: string[];
  pks: string[];
  guard: string | null;
}

async function tableInfo(client: Client, table: string): Promise<TableInfo | null> {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  if (res.rows.length === 0) return null;
  const columns = res.rows.map((r) => r.name as string);
  const pks = res.rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => r.name as string);
  const guard = GUARD_CANDIDATES.find((c) => columns.includes(c)) ?? null;
  return { columns, pks, guard };
}

function toArg(val: unknown): any {
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  return val;
}

let hadError = false;

for (const table of AUTH_TABLES) {
  const src = await tableInfo(source, table);
  if (!src) {
    console.log(`  ${table}: not present on source — skipped`);
    continue;
  }
  const tgt = await tableInfo(target, table);
  if (!tgt) {
    console.log(`  ${table}: MISSING ON TARGET — skipped (fix schema first)`);
    hadError = true;
    continue;
  }
  if (src.pks.length === 0) {
    console.log(`  ${table}: no primary key — skipped (cannot upsert safely)`);
    hadError = true;
    continue;
  }
  // Only copy columns both sides know about.
  const columns = src.columns.filter((c) => tgt.columns.includes(c));
  const guard = src.guard && columns.includes(src.guard) ? src.guard : null;

  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const pkList = src.pks.map((c) => `"${c}"`).join(", ");

  let sql: string;
  if (guard) {
    const updates = columns
      .filter((c) => !src.pks.includes(c))
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(", ");
    sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
           ON CONFLICT(${pkList}) DO UPDATE SET ${updates}
           WHERE excluded."${guard}" > ${table}."${guard}"`;
  } else {
    sql = `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`;
  }

  const countRes = await source.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  const total = Number(countRes.rows[0]!.n);
  const label = guard ? `guard=${guard}` : "no guard column -> INSERT OR IGNORE";

  if (!APPLY) {
    console.log(`  ${table}: ${total} source rows would be upserted (${label})`);
    continue;
  }

  let copied = 0;
  const PAGE = 200;
  for (let offset = 0; offset < total + PAGE; offset += PAGE) {
    const page = await source.execute({
      sql: `SELECT ${colList} FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`,
      args: [PAGE, offset],
    });
    if (page.rows.length === 0) break;
    const stmts = page.rows.map((row) => ({
      sql,
      args: columns.map((c) => toArg((row as any)[c])),
    }));
    await target.batch(stmts, "write");
    copied += page.rows.length;
  }
  console.log(`  ${table}: ${copied}/${total} rows upserted (${label})`);
}

if (hadError) {
  console.error("\nCompleted with errors — review skipped tables above.");
  process.exit(1);
}
console.log(`\n${APPLY ? "Delta-copy complete." : "Dry run complete — rerun with --apply to write."}`);
