/**
 * Integration test for the incremental vector writer against a real local
 * libsql database. Embeddings are mocked; everything else (SQL, diffing,
 * lazy hash backfill, idempotency) runs for real.
 */
import { test, expect, mock, beforeAll } from "bun:test";
import { unlinkSync } from "node:fs";

const DB_PATH = "/tmp/loft-incremental-sync-test.db";
process.env.TURSO_URL = `file:${DB_PATH}`;
process.env.TURSO_AUTH_TOKEN = "";

// Deterministic fake embeddings + call tracking
const embeddedTexts: string[] = [];
mock.module("./embeddings", () => ({
  generateEmbedding: async (text: string) => fakeVector(text),
  generateEmbeddings: async (texts: string[]) => {
    embeddedTexts.push(...texts);
    return texts.map(fakeVector);
  },
}));

function fakeVector(text: string): number[] {
  const v = new Array(1536).fill(0);
  v[0] = text.length;
  return v;
}

// Paragraphs big enough that each becomes (at least) its own chunk
function para(seed: string): string {
  return `${seed} ${seed.repeat(400)}`.slice(0, 2500);
}

let db: any;
let syncVectorsIncrementally: any;

beforeAll(async () => {
  try { unlinkSync(DB_PATH); } catch {}
  ({ db } = await import("../db/client"));
  ({ syncVectorsIncrementally } = await import("./v2-store"));

  await db.execute(`
    CREATE TABLE document_vectors (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      content_hash TEXT,
      embedding F32_BLOB(1536)
    )
  `);
});

async function getRows(docId: string) {
  const r = await db.execute({
    sql: `SELECT id, chunk_index, text, content_hash FROM document_vectors WHERE document_id = ? ORDER BY chunk_index`,
    args: [docId],
  });
  return r.rows;
}

const DOC = "doc-v2-1";
const deadline = () => Date.now() + 60_000;

const p1 = para("alpha");
const p2 = para("bravo");
const p3 = para("charlie");
const p4 = para("delta");

test("initial index embeds everything", async () => {
  embeddedTexts.length = 0;
  const result = await syncVectorsIncrementally(DOC, `${p1}\n\n${p2}\n\n${p3}`, deadline());

  const rows = await getRows(DOC);
  expect(rows.length).toBe(result.chunks.length);
  expect(rows.length).toBeGreaterThanOrEqual(3);
  expect(embeddedTexts.length).toBe(rows.length);
  expect(result.embedded).toBe(rows.length);
  expect(result.reused).toBe(0);
  for (const row of rows) expect(row.content_hash).toBeTruthy();
});

test("re-run with identical text embeds nothing and changes nothing", async () => {
  const before = await getRows(DOC);
  embeddedTexts.length = 0;

  const result = await syncVectorsIncrementally(DOC, `${p1}\n\n${p2}\n\n${p3}`, deadline());

  const after = await getRows(DOC);
  expect(embeddedTexts.length).toBe(0);
  expect(result.reused).toBe(before.length);
  expect(after.map((r: any) => r.id)).toEqual(before.map((r: any) => r.id));
});

test("append re-embeds only the changed tail, prefix rows untouched", async () => {
  const before = await getRows(DOC);
  embeddedTexts.length = 0;

  await syncVectorsIncrementally(DOC, `${p1}\n\n${p2}\n\n${p3}\n\n${p4}`, deadline());

  const after = await getRows(DOC);
  expect(after.length).toBeGreaterThan(before.length);
  // The prefix chunks (all but the old final/boundary chunk) keep their row ids
  const beforeIds = new Set(before.slice(0, -1).map((r: any) => r.id));
  const afterIds = new Set(after.map((r: any) => r.id));
  for (const id of beforeIds) expect(afterIds.has(id)).toBe(true);
  // Far fewer embeddings than total chunks
  expect(embeddedTexts.length).toBeLessThan(after.length);
  expect(embeddedTexts.length).toBeGreaterThan(0);
  // Indexes are contiguous and unique
  expect(after.map((r: any) => r.chunk_index)).toEqual(after.map((_: any, i: number) => i));
});

test("legacy rows without content_hash are backfilled, not re-embedded", async () => {
  await db.execute({ sql: `UPDATE document_vectors SET content_hash = NULL WHERE document_id = ?`, args: [DOC] });
  embeddedTexts.length = 0;

  const result = await syncVectorsIncrementally(DOC, `${p1}\n\n${p2}\n\n${p3}\n\n${p4}`, deadline());

  expect(embeddedTexts.length).toBe(0);
  expect(result.reused).toBe(result.chunks.length);
  const rows = await getRows(DOC);
  for (const row of rows) expect(row.content_hash).toBeTruthy();
});

test("full rewrite replaces all chunks", async () => {
  const before = await getRows(DOC);
  embeddedTexts.length = 0;

  const p5 = para("echo");
  const p6 = para("foxtrot");
  await syncVectorsIncrementally(DOC, `${p5}\n\n${p6}`, deadline());

  const after = await getRows(DOC);
  expect(embeddedTexts.length).toBe(after.length);
  const beforeIds = new Set(before.map((r: any) => r.id));
  for (const row of after) expect(beforeIds.has(row.id)).toBe(false);
});
