import { test, expect } from "bun:test";
import { diffChunks, hashChunk, type ExistingChunk, type NewChunk } from "./chunk-diff";

function existing(rows: Array<[id: string, index: number, text: string]>): ExistingChunk[] {
  return rows.map(([id, chunkIndex, text]) => ({ id, chunkIndex, contentHash: hashChunk(text) }));
}

function next(texts: string[]): NewChunk[] {
  return texts.map((text, index) => ({ index, text, hash: hashChunk(text) }));
}

test("hashChunk is stable and content-sensitive", () => {
  expect(hashChunk("hello")).toBe(hashChunk("hello"));
  expect(hashChunk("hello")).not.toBe(hashChunk("hello "));
});

test("unchanged document: nothing to do", () => {
  const diff = diffChunks(existing([["a", 0, "one"], ["b", 1, "two"]]), next(["one", "two"]));
  expect(diff.toEmbed).toEqual([]);
  expect(diff.toReindex).toEqual([]);
  expect(diff.toDelete).toEqual([]);
  expect(diff.kept).toBe(2);
});

test("append-only file: prefix kept, only the changed tail re-embeds", () => {
  // Appending text changes the final boundary chunk and adds new chunks.
  const diff = diffChunks(
    existing([["a", 0, "one"], ["b", 1, "two"], ["c", 2, "old-tail"]]),
    next(["one", "two", "new-tail", "appended"])
  );
  expect(diff.kept).toBe(2);
  expect(diff.toEmbed.map((c) => c.text)).toEqual(["new-tail", "appended"]);
  expect(diff.toDelete).toEqual(["c"]);
  expect(diff.toReindex).toEqual([]);
});

test("mid-file insertion: shifted chunks reindex without re-embedding", () => {
  const diff = diffChunks(
    existing([["a", 0, "one"], ["b", 1, "two"], ["c", 2, "three"]]),
    next(["one", "inserted", "two", "three"])
  );
  expect(diff.kept).toBe(1); // "one"
  expect(diff.toEmbed.map((c) => c.text)).toEqual(["inserted"]);
  expect(diff.toReindex).toEqual([
    { id: "b", newIndex: 2 },
    { id: "c", newIndex: 3 },
  ]);
  expect(diff.toDelete).toEqual([]);
});

test("duplicate chunk text is matched as a multiset", () => {
  // Two identical chunks in DB, only one in the new text → one kept, one deleted.
  const diff = diffChunks(
    existing([["a", 0, "dup"], ["b", 1, "dup"]]),
    next(["dup"])
  );
  expect(diff.kept).toBe(1);
  expect(diff.toEmbed).toEqual([]);
  expect(diff.toDelete).toEqual(["b"]);
});

test("full rewrite: everything replaced", () => {
  const diff = diffChunks(existing([["a", 0, "one"]]), next(["totally", "different"]));
  expect(diff.kept).toBe(0);
  expect(diff.toEmbed.length).toBe(2);
  expect(diff.toDelete).toEqual(["a"]);
});

test("empty existing (new document): everything embeds", () => {
  const diff = diffChunks([], next(["one", "two"]));
  expect(diff.toEmbed.length).toBe(2);
  expect(diff.toDelete).toEqual([]);
  expect(diff.kept).toBe(0);
});
