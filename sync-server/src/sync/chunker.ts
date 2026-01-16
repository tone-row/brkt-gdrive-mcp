/**
 * Text chunking logic for documents.
 * Target: ~500-1000 tokens per chunk with ~100 token overlap.
 * Roughly 4 chars per token, so ~2000-4000 chars per chunk with ~400 char overlap.
 */

const TARGET_CHUNK_SIZE = 3000; // chars (~750 tokens)
const CHUNK_OVERLAP = 400; // chars (~100 tokens)

export interface Chunk {
  index: number;
  text: string;
}

export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const paragraphs = text.split(/\n\s*\n/);

  let currentChunk = "";
  let chunkIndex = 0;

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;

    // If adding this paragraph would exceed target size, save current chunk
    if (
      currentChunk.length > 0 &&
      currentChunk.length + trimmedParagraph.length > TARGET_CHUNK_SIZE
    ) {
      chunks.push({
        index: chunkIndex++,
        text: currentChunk.trim(),
      });

      // Start new chunk with overlap from the end of previous chunk
      const overlapText = getOverlapText(currentChunk, CHUNK_OVERLAP);
      currentChunk = overlapText + "\n\n" + trimmedParagraph;
    } else {
      // Add paragraph to current chunk
      if (currentChunk.length > 0) {
        currentChunk += "\n\n" + trimmedParagraph;
      } else {
        currentChunk = trimmedParagraph;
      }
    }

    // If a single paragraph is too large, split it by sentences
    if (currentChunk.length > TARGET_CHUNK_SIZE * 1.5) {
      const sentenceChunks = splitBySentences(currentChunk, TARGET_CHUNK_SIZE);
      for (let i = 0; i < sentenceChunks.length - 1; i++) {
        chunks.push({
          index: chunkIndex++,
          text: sentenceChunks[i]!.trim(),
        });
      }
      // Keep the last part as the current chunk with overlap
      currentChunk = sentenceChunks[sentenceChunks.length - 1] ?? "";
    }
  }

  // Add any remaining text as the final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      index: chunkIndex,
      text: currentChunk.trim(),
    });
  }

  return chunks;
}

function getOverlapText(text: string, targetLength: number): string {
  if (text.length <= targetLength) return text;

  // Try to break at a sentence boundary
  const lastPart = text.slice(-targetLength);
  const sentenceMatch = lastPart.match(/[.!?]\s+/);

  if (sentenceMatch && sentenceMatch.index !== undefined) {
    return lastPart.slice(sentenceMatch.index + sentenceMatch[0].length);
  }

  // Fall back to word boundary
  const wordMatch = lastPart.match(/\s+/);
  if (wordMatch && wordMatch.index !== undefined) {
    return lastPart.slice(wordMatch.index + wordMatch[0].length);
  }

  return lastPart;
}

function splitBySentences(text: string, targetSize: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > targetSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
