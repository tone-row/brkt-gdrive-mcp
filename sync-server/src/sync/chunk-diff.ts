/**
 * Content-hash-based chunk diffing.
 *
 * Chunking is deterministic from the top of the document, so an append-only
 * doc produces byte-identical chunks for everything except the final boundary
 * chunk. By hashing chunk text we can re-embed only what actually changed.
 *
 * Pure functions — no I/O — so the diff logic is unit-testable.
 */

import { createHash } from "node:crypto";

export interface ExistingChunk {
  id: string;
  chunkIndex: number;
  contentHash: string;
}

export interface NewChunk {
  index: number;
  text: string;
  hash: string;
}

export interface ChunkDiff {
  /** Chunks not present in the DB — need embedding + insert */
  toEmbed: NewChunk[];
  /** Existing chunks kept, but their position in the doc moved */
  toReindex: { id: string; newIndex: number }[];
  /** Existing chunk ids no longer present in the new text */
  toDelete: string[];
  /** Count of chunks kept untouched (same hash, same index) */
  kept: number;
}

export function hashChunk(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Diff existing chunks against the newly-computed chunk list.
 *
 * Matching is by content hash, treated as a multiset (the same paragraph can
 * legitimately appear twice in a doc). Matches are claimed in document order
 * so index updates stay minimal for append-only files.
 */
export function diffChunks(existing: ExistingChunk[], next: NewChunk[]): ChunkDiff {
  const byHash = new Map<string, ExistingChunk[]>();
  const sorted = [...existing].sort((a, b) => a.chunkIndex - b.chunkIndex);
  for (const chunk of sorted) {
    const queue = byHash.get(chunk.contentHash);
    if (queue) {
      queue.push(chunk);
    } else {
      byHash.set(chunk.contentHash, [chunk]);
    }
  }

  const toEmbed: NewChunk[] = [];
  const toReindex: { id: string; newIndex: number }[] = [];
  let kept = 0;

  for (const chunk of next) {
    const queue = byHash.get(chunk.hash);
    const match = queue?.shift();
    if (match) {
      if (match.chunkIndex === chunk.index) {
        kept++;
      } else {
        toReindex.push({ id: match.id, newIndex: chunk.index });
      }
    } else {
      toEmbed.push(chunk);
    }
  }

  const toDelete: string[] = [];
  for (const queue of byHash.values()) {
    for (const chunk of queue) {
      toDelete.push(chunk.id);
    }
  }

  return { toEmbed, toReindex, toDelete, kept };
}
