#!/usr/bin/env bun
/**
 * Creates a backup of the Turso database.
 *
 * Usage:
 *   bun scripts/backup-database.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${timestamp}.sql`;

  console.log(`Creating database backup: ${filename}\n`);

  // Get all table names
  const tablesResult = await db.execute(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%'
    ORDER BY name
  `);

  const tables = tablesResult.rows.map((r) => r.name as string);
  console.log(`Found ${tables.length} tables: ${tables.join(", ")}\n`);

  // Build SQL dump
  const lines: string[] = [];
  lines.push("-- Database backup");
  lines.push(`-- Created: ${new Date().toISOString()}`);
  lines.push("-- Tables: " + tables.join(", "));
  lines.push("");
  lines.push("PRAGMA foreign_keys=OFF;");
  lines.push("BEGIN TRANSACTION;");
  lines.push("");

  for (const table of tables) {
    console.log(`Dumping table: ${table}`);

    // Get CREATE TABLE statement
    const schemaResult = await db.execute({
      sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      args: [table],
    });

    if (schemaResult.rows.length > 0 && schemaResult.rows[0]!.sql) {
      lines.push(`-- Table: ${table}`);
      lines.push(`DROP TABLE IF EXISTS ${table};`);
      lines.push((schemaResult.rows[0]!.sql as string) + ";");
      lines.push("");
    }

    // Get all rows
    const dataResult = await db.execute(`SELECT * FROM ${table}`);

    if (dataResult.rows.length > 0) {
      const columns = dataResult.columns;

      for (const row of dataResult.rows) {
        const values = columns.map((col) => {
          const val = row[col];
          if (val === null) return "NULL";
          if (typeof val === "number") return val.toString();
          if (typeof val === "string") {
            // Escape single quotes
            return `'${val.replace(/'/g, "''")}'`;
          }
          // Handle blobs/buffers (like embeddings)
          if (val instanceof ArrayBuffer || ArrayBuffer.isView(val)) {
            return "NULL"; // Skip binary data for text dump
          }
          return `'${String(val).replace(/'/g, "''")}'`;
        });

        lines.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")});`);
      }
      lines.push("");
    }
  }

  // Get indexes
  const indexResult = await db.execute(`
    SELECT sql FROM sqlite_master
    WHERE type='index' AND sql IS NOT NULL
    ORDER BY name
  `);

  if (indexResult.rows.length > 0) {
    lines.push("-- Indexes");
    for (const row of indexResult.rows) {
      if (row.sql) {
        lines.push((row.sql as string) + ";");
      }
    }
    lines.push("");
  }

  lines.push("COMMIT;");
  lines.push("PRAGMA foreign_keys=ON;");

  // Write to file
  const content = lines.join("\n");
  await Bun.write(filename, content);

  console.log(`\nBackup saved to: ${filename}`);
  console.log(`Size: ${(content.length / 1024).toFixed(2)} KB`);

  // Also show table stats
  console.log("\nTable statistics:");
  for (const table of tables) {
    const countResult = await db.execute(`SELECT COUNT(*) as count FROM ${table}`);
    console.log(`  ${table}: ${countResult.rows[0]?.count} rows`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
