#!/usr/bin/env bun
/**
 * Full binary-safe backup of the Turso database into a local SQLite file.
 *
 * Unlike backup-database.ts (text dump that writes blobs as NULL), this
 * preserves embeddings exactly, paginates reads so large tables don't load
 * into memory at once, and verifies row counts at the end. The output file is
 * a regular SQLite/libsql DB you can query directly.
 *
 * Data only — indexes (including vector indexes) are not copied; they can be
 * recreated from schema.ts on restore.
 *
 * Usage: bun scripts/full-backup.ts
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient, type InValue } from "@libsql/client";
import { mkdirSync } from "node:fs";

const PAGE_SIZE = 200;

const remote = createClient({
  url: process.env.TURSO_URL!.replace(/^libsql:/, "https:"),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync("backups", { recursive: true });
const path = `backups/loft-backup-${timestamp}.db`;
const local = createClient({ url: `file:${path}` });

// Tables are copied in alphabetical order, so FK targets may not exist yet
await local.execute(`PRAGMA foreign_keys=OFF`);

// Tables in FK-safe order is irrelevant here (local file has no FK pragma on
// by default), but skip libsql/sqlite internals and vector index shadow tables.
const tablesResult = await remote.execute(`
  SELECT name, sql FROM sqlite_master
  WHERE type='table'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_litestream_%'
    AND name NOT LIKE '%_shadow'
    AND sql IS NOT NULL
  ORDER BY name
`);

console.log(`Backing up ${tablesResult.rows.length} tables to ${path}\n`);

const counts: Record<string, { remote: number; local: number }> = {};

for (const tableRow of tablesResult.rows) {
  const table = tableRow.name as string;
  await local.execute(tableRow.sql as string);

  const countResult = await remote.execute(`SELECT COUNT(*) as n FROM ${table}`);
  const total = Number(countResult.rows[0]!.n);
  counts[table] = { remote: total, local: 0 };

  let copied = 0;
  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const page = await remote.execute({
      sql: `SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`,
      args: [PAGE_SIZE, offset],
    });
    if (page.rows.length === 0) break;

    const columns = page.columns;
    const placeholders = `(${columns.map(() => "?").join(",")})`;
    try {
      await local.batch(
        page.rows.map((row) => ({
          sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`,
          args: columns.map((col) => {
            const val = row[col];
            if (val instanceof ArrayBuffer) return new Uint8Array(val);
            return val as InValue;
          }),
        })),
        "write"
      );
    } catch (error: any) {
      console.error(`\nFAILED on table=${table} offset=${offset}`);
      console.error(`columns from remote SELECT *: ${JSON.stringify(columns)}`);
      throw error;
    }
    copied += page.rows.length;
    if (total > PAGE_SIZE) {
      process.stdout.write(`\r  ${table}: ${copied}/${total}`);
    }
  }

  const localCount = await local.execute(`SELECT COUNT(*) as n FROM ${table}`);
  counts[table]!.local = Number(localCount.rows[0]!.n);
  const ok = counts[table]!.local === total ? "✓" : "✗ MISMATCH";
  console.log(`\r  ${table}: ${counts[table]!.local}/${total} ${ok}`);
}

const mismatches = Object.entries(counts).filter(([, c]) => c.remote !== c.local);
const size = Bun.file(path).size;
console.log(`\nBackup ${mismatches.length === 0 ? "complete" : "FAILED"}: ${path} (${(size / 1024 / 1024).toFixed(1)} MB)`);
if (mismatches.length > 0) {
  for (const [table, c] of mismatches) console.error(`  MISMATCH ${table}: remote=${c.remote} local=${c.local}`);
  process.exit(1);
}
process.exit(0);
