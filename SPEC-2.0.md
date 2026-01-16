# Google Drive Vector Search MCP - v2.0

Advanced semantic search over Google Drive documents with hybrid retrieval, HyDE query expansion, and cross-encoder reranking.

> **v2.0 Migration (January 2025):** This version introduces significant upgrades to search quality:
> - **Voyage AI embeddings** replacing OpenAI (8-10% better retrieval)
> - **Hybrid search** combining BM25 keyword matching with dense vectors (15-30% better recall)
> - **Smart intent classification** via Cerebras for automatic query routing (~30ms overhead)
> - **HyDE query expansion** for conceptual queries
> - **Cohere reranking** for precision-critical queries (20-40% lift)
> - **Single `search` tool** with automatic routing to retrieve/discover/gather
>
> This requires a full re-index of all documents due to embedding model change.

## Overview

This project enables semantic search over Google Docs for any user who connects their Google account. v2.0 adds sophisticated retrieval techniques while maintaining the same multi-tenant architecture.

**Key Changes from v1.0:**
| Component | v1.0 | v2.0 |
|-----------|------|------|
| Embeddings | OpenAI text-embedding-3-small (1536d) | Voyage AI voyage-3.5 (1024d) |
| Retrieval | Vector similarity only | Hybrid (BM25 + vector) with RRF fusion |
| Query Enhancement | None | HyDE + multi-query |
| Ranking | None | Cohere Rerank 3.5 |
| Search API | 1 generic `search` | Smart `search` with intent classification |
| Intent Routing | N/A | Cerebras Llama 3.3 70B (~30ms) |
| Chunking | Paragraph boundaries | Structure-aware (respects headings) |

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web App       │    │  MCP Client     │    │  GitHub Actions │
│   (Frontend)    │    │  (Claude, etc)  │    │  (Cron: 2x/day) │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         │ OAuth +              │ API Key              │
         │ Better Auth          │                      │
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │   Vercel API    │
                       │  + Better Auth  │
                       └────────┬────────┘
                                │
       ┌────────────────────────┼────────────────────────┐
       ▼                        ▼                        ▼
┌─────────────┐          ┌─────────────┐          ┌─────────────┐
│    Turso    │          │  Voyage AI  │          │ Google APIs │
│ (vectors +  │          │ (embeddings)│          │(OAuth/Drive)│
│    FTS5)    │          └─────────────┘          └─────────────┘
└─────────────┘                 │
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
      ┌──────────┐        ┌──────────┐        ┌──────────┐
      │ Cerebras │        │  OpenAI  │        │  Cohere  │
      │ (intent  │        │ (HyDE)   │        │ (rerank) │
      │  routing)│        └──────────┘        └──────────┘
      └──────────┘
```

### Search Flow

```
User Query + Context
        │
        ▼
┌───────────────────┐
│ Intent Classifier │  ← Cerebras Llama 3.3 70B (~30ms)
│   (smart router)  │
└─────────┬─────────┘
          │
    ┌─────┴─────┬─────────────┐
    ▼           ▼             ▼
┌────────┐ ┌─────────┐ ┌──────────┐
│retrieve│ │discover │ │  gather  │
│ ~100ms │ │ ~500ms  │ │  ~800ms  │
└────────┘ └─────────┘ └──────────┘
    │           │             │
    │      HyDE + MMR    HyDE + Rerank
    │           │             │
    └───────────┴─────────────┘
                │
                ▼
         Search Results
```

## New Dependencies

Add these to `www/package.json`:

```bash
# Vercel AI SDK + providers
bun add ai @ai-sdk/openai @ai-sdk/cerebras

# Note: openai package is already installed, keep it for Voyage API calls
# which don't have a Vercel AI SDK provider yet
```

### Vercel AI SDK
- **Purpose**: Unified interface for LLM providers
- **Packages**: `ai`, `@ai-sdk/openai`, `@ai-sdk/cerebras`
- **Used for**: Intent classification (Cerebras), HyDE generation (OpenAI)

### Voyage AI
- **Purpose**: Document and query embeddings
- **Model**: `voyage-3.5` at 1024 dimensions
- **Cost**: $0.06 per 1M tokens (~$2/year for 10K documents)
- **Free tier**: 200M tokens (covers first year+)
- **API**: Direct fetch to `https://api.voyageai.com/v1/embeddings`
- **Note**: No Vercel AI SDK provider - use fetch directly

### Cohere
- **Purpose**: Cross-encoder reranking for `gather()` function
- **Model**: `rerank-english-v3.0`
- **Cost**: $2 per 1,000 queries (only used for `gather()`)
- **API**: Direct fetch to `https://api.cohere.ai/v1/rerank`
- **Note**: No Vercel AI SDK provider - use fetch directly

### Cerebras
- **Purpose**: Ultra-fast intent classification (~20-50ms)
- **Model**: `llama-3.3-70b`
- **Cost**: ~$0.10 per 1M tokens (negligible for short classifications)
- **Package**: `@ai-sdk/cerebras`
- **Why Cerebras**: Fastest inference available - critical for keeping classification overhead minimal

### OpenAI (expanded use)
- **Purpose**: HyDE hypothetical document generation
- **Model**: `gpt-4o-mini` (fast, cheap)
- **Cost**: ~$0.15 per 1,000 queries using HyDE
- **Package**: `@ai-sdk/openai` (via Vercel AI SDK)
- **Note**: Already installed as `openai` package - add the AI SDK wrapper

## Database Schema Changes

### Modified: `chunks` table

```sql
-- v1.0 schema
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  user_id TEXT,
  chunk_index INTEGER,
  text TEXT,
  embedding F32_BLOB(1536)  -- OpenAI dimensions
);

-- v2.0 schema
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  heading_path TEXT,              -- NEW: e.g., "Budget > Q1 Expenses"
  content_type TEXT DEFAULT 'prose',  -- NEW: 'prose', 'list', 'table', 'code'
  embedding F32_BLOB(1024),       -- CHANGED: Voyage dimensions
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for filtered vector search
CREATE INDEX idx_chunks_user ON chunks(user_id);
```

### New: `chunks_fts` virtual table (FTS5 for BM25)

```sql
-- FTS5 virtual table shadows the chunks table for keyword search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  heading_path,
  content='chunks',
  content_rowid='rowid'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading_path) 
  VALUES (NEW.rowid, NEW.text, NEW.heading_path);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path) 
  VALUES('delete', OLD.rowid, OLD.text, OLD.heading_path);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path) 
  VALUES('delete', OLD.rowid, OLD.text, OLD.heading_path);
  INSERT INTO chunks_fts(rowid, text, heading_path) 
  VALUES (NEW.rowid, NEW.text, NEW.heading_path);
END;
```

### Modified: `documents` table

```sql
-- Add structure metadata
ALTER TABLE documents ADD COLUMN has_headings INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN heading_structure TEXT;  -- JSON of heading tree
ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0;
```

## Chunking Strategy (v2.0)

### Structure-Aware Chunking via HTML Export

Currently, Google Docs are exported as plain text via `exportDocAsText()`, which loses heading structure. To enable structure-aware chunking, we'll export as HTML instead and parse the heading tags.

**Updated Google Drive export:**

```typescript
// src/sync/google-drive.ts

/**
 * Export a Google Doc as HTML (preserves heading structure)
 */
export async function exportDocAsHtml(tokens: GoogleTokens, docId: string): Promise<string> {
  const auth = getOAuthClient(tokens);
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.export({
    fileId: docId,
    mimeType: "text/html",
  });

  return response.data as string;
}

/**
 * Parse HTML export to extract text with heading structure
 */
export interface ParsedParagraph {
  text: string;
  style: 'NORMAL_TEXT' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'HEADING_4';
}

export function parseGoogleDocHtml(html: string): ParsedParagraph[] {
  const paragraphs: ParsedParagraph[] = [];
  
  // Simple regex-based parsing (works for Google Docs HTML export)
  // Google Docs uses <h1>, <h2>, <h3> for headings and <p> for normal text
  const tagRegex = /<(h[1-4]|p)[^>]*>(.*?)<\/\1>/gi;
  
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1]!.toLowerCase();
    const content = match[2]!
      .replace(/<[^>]+>/g, '')  // Strip inner HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    
    if (!content) continue;
    
    const style = tag === 'h1' ? 'HEADING_1'
      : tag === 'h2' ? 'HEADING_2'
      : tag === 'h3' ? 'HEADING_3'
      : tag === 'h4' ? 'HEADING_4'
      : 'NORMAL_TEXT';
    
    paragraphs.push({ text: content, style });
  }
  
  return paragraphs;
}

// Keep the plain text export for full_text storage
export async function exportDocAsText(tokens: GoogleTokens, docId: string): Promise<string> {
  const auth = getOAuthClient(tokens);
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.export({
    fileId: docId,
    mimeType: "text/plain",
  });

  return response.data as string;
}
```

### Structure-Aware Chunker

The new chunker respects Google Docs heading structure while gracefully handling unstructured documents (like transcripts).

**Parameters:**
- **Target chunk size**: 512 tokens (~400 words)
- **Overlap**: 50 tokens
- **Max chunk size**: 768 tokens (hard limit)
- **Min chunk size**: 100 tokens (merge small chunks)

**Algorithm:**

```typescript
// src/sync/chunker.ts

interface ChunkResult {
  text: string;
  chunkIndex: number;
  headingPath: string | null;
  contentType: 'prose' | 'list' | 'table' | 'code';
}

interface GoogleDocParagraph {
  text: string;
  style: 'NORMAL_TEXT' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'HEADING_4';
}

export function chunkGoogleDoc(paragraphs: GoogleDocParagraph[]): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;
  let currentHeadingPath: string[] = [];
  let chunkIndex = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para.text);
    
    // Headings trigger chunk boundaries
    if (para.style.startsWith('HEADING_')) {
      // Flush current chunk if non-empty
      if (currentChunk.length > 0 && currentTokens >= 100) {
        chunks.push({
          text: currentChunk.join('\n\n'),
          chunkIndex: chunkIndex++,
          headingPath: currentHeadingPath.join(' > ') || null,
          contentType: detectContentType(currentChunk.join('\n\n'))
        });
        currentChunk = [];
        currentTokens = 0;
      }
      
      // Update heading path based on level
      const level = parseInt(para.style.replace('HEADING_', ''));
      currentHeadingPath = currentHeadingPath.slice(0, level - 1);
      currentHeadingPath.push(para.text.trim());
      
      // Include heading in next chunk for context
      currentChunk.push(para.text);
      currentTokens += paraTokens;
      continue;
    }
    
    // Would this paragraph push us over the limit?
    if (currentTokens + paraTokens > 512 && currentChunk.length > 0) {
      // Flush current chunk
      chunks.push({
        text: currentChunk.join('\n\n'),
        chunkIndex: chunkIndex++,
        headingPath: currentHeadingPath.join(' > ') || null,
        contentType: detectContentType(currentChunk.join('\n\n'))
      });
      
      // Start new chunk with overlap (last paragraph)
      const lastPara = currentChunk[currentChunk.length - 1];
      currentChunk = lastPara ? [lastPara] : [];
      currentTokens = lastPara ? estimateTokens(lastPara) : 0;
    }
    
    currentChunk.push(para.text);
    currentTokens += paraTokens;
  }
  
  // Flush final chunk
  if (currentChunk.length > 0 && currentTokens >= 100) {
    chunks.push({
      text: currentChunk.join('\n\n'),
      chunkIndex: chunkIndex++,
      headingPath: currentHeadingPath.join(' > ') || null,
      contentType: detectContentType(currentChunk.join('\n\n'))
    });
  }
  
  return chunks;
}

function detectContentType(text: string): 'prose' | 'list' | 'table' | 'code' {
  const lines = text.split('\n');
  const bulletLines = lines.filter(l => /^[\s]*[-•*]\s/.test(l) || /^[\s]*\d+\.\s/.test(l));
  
  if (bulletLines.length > lines.length * 0.5) return 'list';
  if (text.includes('```') || /^[\s]{4,}/.test(text)) return 'code';
  if (text.includes('\t') && lines.length > 2) return 'table';
  return 'prose';
}

function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters for English
  return Math.ceil(text.length / 4);
}
```

### Handling Unstructured Documents (Transcripts)

For documents without headings, the chunker falls back to paragraph-boundary splitting with the same token limits. The `heading_path` will be `null` for these chunks.

### Sync Integration

Update `www/src/sync/index.ts` to use HTML export for chunking:

```typescript
// In indexDocument() and updateDocument(), change:

// OLD:
const text = await exportDocAsText(tokens, doc.id);
const chunks = chunkText(text);

// NEW:
const [plainText, html] = await Promise.all([
  exportDocAsText(tokens, doc.id),  // Keep for full_text storage
  exportDocAsHtml(tokens, doc.id),  // For structured chunking
]);

const paragraphs = parseGoogleDocHtml(html);
const hasHeadings = paragraphs.some(p => p.style !== 'NORMAL_TEXT');
const chunks = chunkGoogleDoc(paragraphs);

// When inserting document, add has_headings flag:
await db.execute({
  sql: `INSERT INTO documents (id, user_id, google_doc_id, title, full_text, google_modified_time, has_headings, chunk_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [docId, userId, doc.id, doc.name, plainText, doc.modifiedTime, hasHeadings ? 1 : 0, chunks.length],
});

// When inserting chunks, include heading_path and content_type:
await db.execute({
  sql: `INSERT INTO chunks (id, document_id, user_id, chunk_index, text, heading_path, content_type, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, vector(?))`,
  args: [
    chunkId,
    docId,
    userId,
    chunks[i]!.chunkIndex,
    chunks[i]!.text,
    chunks[i]!.headingPath,
    chunks[i]!.contentType,
    `[${embeddings[i]!.join(",")}]`,
  ],
});
```

## Embedding Pipeline (v2.0)

### Voyage AI Integration

```typescript
// src/sync/embeddings.ts

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

export class VoyageEmbeddings {
  private apiKey: string;
  private model = 'voyage-3.5';
  private dimensions = 1024;
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: 'document',  // CRITICAL: use 'document' for indexing
        output_dimension: this.dimensions
      })
    });
    
    const data: VoyageEmbeddingResponse = await response.json();
    return data.data.map(d => d.embedding);
  }
  
  async embedQuery(query: string): Promise<number[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: [query],
        input_type: 'query',  // CRITICAL: use 'query' for search
        output_dimension: this.dimensions
      })
    });
    
    const data: VoyageEmbeddingResponse = await response.json();
    return data.data[0].embedding;
  }
}
```

## Search Functions (v2.0 MCP Tools)

### Overview

v2.0 exposes three specialized search functions, each optimized for different user intents:

| Function | Intent | Techniques | Latency | Use Case |
|----------|--------|------------|---------|----------|
| `retrieve` | Lookup | Hybrid (BM25 heavy) | ~100ms | "Find the Q3 budget doc" |
| `discover` | Explore | HyDE + multi-query + MMR | ~500ms | "What have we written about partnerships?" |
| `gather` | RAG prep | HyDE + multi-query + rerank | ~800ms | "Get context to answer: What's our pricing strategy?" |

### Function 1: `retrieve()`

Fast, precise retrieval for known-item search. Optimized for queries where the user knows what they're looking for.

```typescript
// api/retrieve.ts

interface RetrieveParams {
  query: string;
  topK?: number;           // default: 5
  dateAfter?: string;      // ISO date filter
  dateBefore?: string;     // ISO date filter
}

interface RetrieveResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  text: string;
  headingPath: string | null;
  score: number;
}

export async function retrieve(
  userId: string, 
  params: RetrieveParams
): Promise<RetrieveResult[]> {
  const { query, topK = 5, dateAfter, dateBefore } = params;
  
  // 1. Embed the query
  const queryEmbedding = await voyageEmbeddings.embedQuery(query);
  
  // 2. BM25 search via FTS5
  const bm25Results = await db.execute({
    sql: `
      SELECT c.id, c.document_id, c.text, c.heading_path, bm25(chunks_fts) as bm25_score
      FROM chunks_fts
      JOIN chunks c ON chunks_fts.rowid = c.rowid
      JOIN documents d ON c.document_id = d.id
      WHERE chunks_fts MATCH ?
        AND c.user_id = ?
        ${dateAfter ? 'AND d.google_modified_time >= ?' : ''}
        ${dateBefore ? 'AND d.google_modified_time <= ?' : ''}
      ORDER BY bm25_score
      LIMIT 25
    `,
    args: [query, userId, dateAfter, dateBefore].filter(Boolean)
  });
  
  // 3. Vector search via libSQL vector
  const vectorResults = await db.execute({
    sql: `
      SELECT c.id, c.document_id, c.text, c.heading_path,
             vector_distance_cos(c.embedding, ?) as vec_distance
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.user_id = ?
        ${dateAfter ? 'AND d.google_modified_time >= ?' : ''}
        ${dateBefore ? 'AND d.google_modified_time <= ?' : ''}
      ORDER BY vec_distance
      LIMIT 25
    `,
    args: [vectorToBlob(queryEmbedding), userId, dateAfter, dateBefore].filter(Boolean)
  });
  
  // 4. Reciprocal Rank Fusion (BM25 weighted higher for retrieve)
  const fused = reciprocalRankFusion(bm25Results.rows, vectorResults.rows, {
    bm25Weight: 0.6,  // Favor keyword matches for known-item search
    vectorWeight: 0.4,
    k: 60
  });
  
  // 5. Fetch document metadata and return top K
  const topResults = fused.slice(0, topK);
  return enrichWithDocumentMetadata(topResults);
}
```

### Function 2: `discover()`

Exploratory search for surfacing connections and related content. Uses HyDE for conceptual queries and MMR for diverse results.

```typescript
// api/discover.ts

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface DiscoverParams {
  query?: string;                    // Natural language query
  seedDocumentId?: string;           // OR start from a document
  topK?: number;                     // default: 10
  diversityFactor?: number;          // 0-1, default: 0.3
}

interface DiscoverResult extends RetrieveResult {
  cluster: string;          // Thematic grouping
  relationshipType: string; // "similar topic", "same project", etc.
}

export async function discover(
  userId: string,
  params: DiscoverParams
): Promise<DiscoverResult[]> {
  const { query, seedDocumentId, topK = 10, diversityFactor = 0.3 } = params;
  
  let searchEmbeddings: number[][] = [];
  
  if (seedDocumentId) {
    // Get embeddings from seed document chunks
    const seedChunks = await db.execute({
      sql: 'SELECT embedding FROM chunks WHERE document_id = ? LIMIT 3',
      args: [seedDocumentId]
    });
    searchEmbeddings = seedChunks.rows.map(r => blobToVector(r.embedding));
  } else if (query) {
    // Generate HyDE hypothetical document
    const hydeDoc = await generateHypotheticalDocument(query);
    
    // Multi-query: original + HyDE + variation
    const queryVariation = await generateQueryVariation(query);
    
    const [originalEmb, hydeEmb, variationEmb] = await Promise.all([
      voyageEmbeddings.embedQuery(query),
      voyageEmbeddings.embedQuery(hydeDoc),
      voyageEmbeddings.embedQuery(queryVariation)
    ]);
    
    searchEmbeddings = [originalEmb, hydeEmb, variationEmb];
  }
  
  // Search with each embedding
  const allResults: Map<string, { chunk: any; scores: number[] }> = new Map();
  
  for (const embedding of searchEmbeddings) {
    const results = await db.execute({
      sql: `
        SELECT c.id, c.document_id, c.text, c.heading_path,
               vector_distance_cos(c.embedding, ?) as vec_distance
        FROM chunks c
        WHERE c.user_id = ?
        ORDER BY vec_distance
        LIMIT 30
      `,
      args: [vectorToBlob(embedding), userId]
    });
    
    for (const row of results.rows) {
      const existing = allResults.get(row.id);
      if (existing) {
        existing.scores.push(1 - row.vec_distance); // Convert distance to similarity
      } else {
        allResults.set(row.id, { chunk: row, scores: [1 - row.vec_distance] });
      }
    }
  }
  
  // Score by average similarity across queries
  const scored = Array.from(allResults.entries())
    .map(([id, { chunk, scores }]) => ({
      ...chunk,
      score: scores.reduce((a, b) => a + b, 0) / scores.length
    }))
    .sort((a, b) => b.score - a.score);
  
  // Apply MMR for diversity
  const diverse = maximalMarginalRelevance(scored, diversityFactor, topK);
  
  // Cluster results by document/topic
  const clustered = await clusterResults(diverse);
  
  return enrichWithDocumentMetadata(clustered);
}

async function generateHypotheticalDocument(query: string): Promise<string> {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    system: 'Write a short paragraph (2-3 sentences) that would appear in a document answering this question. Write as if you are the document, not as if you are answering the question.',
    prompt: query,
    maxTokens: 150,
    temperature: 0.7
  });
  return text || query;
}

async function generateQueryVariation(query: string): Promise<string> {
  const { text } = await generateText({
    model: openai('gpt-4o-mini'),
    system: 'Rephrase this search query using different words but the same meaning. Output only the rephrased query.',
    prompt: query,
    maxTokens: 50,
    temperature: 0.5
  });
  return text || query;
}
```

### Function 3: `gather()`

Comprehensive retrieval optimized for RAG/question-answering. Uses full pipeline with reranking.

```typescript
// api/gather.ts

interface GatherParams {
  question: string;
  thoroughness?: 'quick' | 'balanced' | 'comprehensive';  // default: 'balanced'
  maxTokens?: number;  // default: 4000
}

interface GatherResult {
  chunks: RetrieveResult[];
  sources: Array<{
    documentId: string;
    documentTitle: string;
    documentUrl: string;
    chunkCount: number;
  }>;
  totalTokens: number;
  confidence: 'low' | 'medium' | 'high';
  queryVariations: string[];
}

const THOROUGHNESS_CONFIG = {
  quick: { queryCount: 1, initialK: 20, rerankTo: 5 },
  balanced: { queryCount: 3, initialK: 50, rerankTo: 10 },
  comprehensive: { queryCount: 5, initialK: 100, rerankTo: 15 }
};

export async function gather(
  userId: string,
  params: GatherParams
): Promise<GatherResult> {
  const { question, thoroughness = 'balanced', maxTokens = 4000 } = params;
  const config = THOROUGHNESS_CONFIG[thoroughness];
  
  // 1. Generate query variations (HyDE + rephrases)
  const queryVariations = await generateQueryVariations(question, config.queryCount);
  
  // 2. Hybrid search for each query variation
  const allChunks: Map<string, { chunk: any; scores: number[] }> = new Map();
  
  for (const queryText of queryVariations) {
    const queryEmbedding = await voyageEmbeddings.embedQuery(queryText);
    
    // BM25 results
    const bm25Results = await db.execute({
      sql: `
        SELECT c.id, c.document_id, c.text, c.heading_path, bm25(chunks_fts) as score
        FROM chunks_fts
        JOIN chunks c ON chunks_fts.rowid = c.rowid
        WHERE chunks_fts MATCH ? AND c.user_id = ?
        ORDER BY score
        LIMIT ?
      `,
      args: [queryText, userId, config.initialK]
    });
    
    // Vector results
    const vectorResults = await db.execute({
      sql: `
        SELECT c.id, c.document_id, c.text, c.heading_path,
               vector_distance_cos(c.embedding, ?) as score
        FROM chunks c
        WHERE c.user_id = ?
        ORDER BY score
        LIMIT ?
      `,
      args: [vectorToBlob(queryEmbedding), userId, config.initialK]
    });
    
    // Fuse and accumulate
    const fused = reciprocalRankFusion(bm25Results.rows, vectorResults.rows, {
      bm25Weight: 0.5,
      vectorWeight: 0.5,
      k: 60
    });
    
    for (const result of fused) {
      const existing = allChunks.get(result.id);
      if (existing) {
        existing.scores.push(result.score);
      } else {
        allChunks.set(result.id, { chunk: result, scores: [result.score] });
      }
    }
  }
  
  // 3. Deduplicate and pre-rank by average score
  const candidates = Array.from(allChunks.entries())
    .map(([id, { chunk, scores }]) => ({
      ...chunk,
      avgScore: scores.reduce((a, b) => a + b, 0) / scores.length
    }))
    .sort((a, b) => b.avgScore - a.avgScore)
    .slice(0, 50);  // Send top 50 to reranker
  
  // 4. Rerank with Cohere
  const reranked = await cohereRerank(question, candidates, config.rerankTo);
  
  // 5. Fit within token budget
  const { chunks: finalChunks, totalTokens } = fitToTokenBudget(reranked, maxTokens);
  
  // 6. Calculate confidence based on top scores
  const avgTopScore = finalChunks.slice(0, 3).reduce((a, c) => a + c.score, 0) / 3;
  const confidence = avgTopScore > 0.7 ? 'high' : avgTopScore > 0.4 ? 'medium' : 'low';
  
  // 7. Aggregate sources
  const sources = aggregateSources(finalChunks);
  
  return {
    chunks: await enrichWithDocumentMetadata(finalChunks),
    sources,
    totalTokens,
    confidence,
    queryVariations
  };
}

async function cohereRerank(
  query: string, 
  documents: any[], 
  topN: number
): Promise<any[]> {
  const response = await fetch('https://api.cohere.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'rerank-english-v3.0',
      query,
      documents: documents.map(d => d.text),
      top_n: topN,
      return_documents: false
    })
  });
  
  const data = await response.json();
  
  return data.results.map((r: any) => ({
    ...documents[r.index],
    score: r.relevance_score
  }));
}

async function generateQueryVariations(question: string, count: number): Promise<string[]> {
  const variations = [question];
  
  if (count >= 2) {
    // Add HyDE
    const hydeDoc = await generateHypotheticalDocument(question);
    variations.push(hydeDoc);
  }
  
  if (count >= 3) {
    // Add rephrased query
    const rephrase = await generateQueryVariation(question);
    variations.push(rephrase);
  }
  
  if (count >= 4) {
    // Add keyword extraction
    const keywords = await extractKeywords(question);
    variations.push(keywords);
  }
  
  if (count >= 5) {
    // Add another rephrase
    const rephrase2 = await generateQueryVariation(question);
    variations.push(rephrase2);
  }
  
  return variations;
}
```

## Utility Functions

### Reciprocal Rank Fusion

```typescript
// src/lib/fusion.ts

interface FusionOptions {
  bm25Weight: number;
  vectorWeight: number;
  k: number;  // RRF constant, typically 60
}

export function reciprocalRankFusion(
  bm25Results: any[],
  vectorResults: any[],
  options: FusionOptions
): any[] {
  const { bm25Weight, vectorWeight, k } = options;
  const scores: Map<string, { chunk: any; score: number }> = new Map();
  
  // Score BM25 results
  bm25Results.forEach((result, rank) => {
    const rrfScore = bm25Weight * (1 / (k + rank + 1));
    scores.set(result.id, { chunk: result, score: rrfScore });
  });
  
  // Add vector scores
  vectorResults.forEach((result, rank) => {
    const rrfScore = vectorWeight * (1 / (k + rank + 1));
    const existing = scores.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(result.id, { chunk: result, score: rrfScore });
    }
  });
  
  // Sort by combined score
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ chunk, score }) => ({ ...chunk, score }));
}
```

### Maximal Marginal Relevance (MMR)

```typescript
// src/lib/mmr.ts

export function maximalMarginalRelevance(
  results: any[],
  diversityFactor: number,  // lambda: 0 = max diversity, 1 = max relevance
  topK: number
): any[] {
  if (results.length <= topK) return results;
  
  const selected: any[] = [];
  const candidates = [...results];
  
  // Always select the most relevant first
  selected.push(candidates.shift()!);
  
  while (selected.length < topK && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      
      // Relevance component
      const relevance = candidate.score;
      
      // Diversity component: max similarity to already selected
      const maxSim = Math.max(
        ...selected.map(s => textSimilarity(candidate.text, s.text))
      );
      
      // MMR score
      const mmrScore = (1 - diversityFactor) * relevance - diversityFactor * maxSim;
      
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    
    selected.push(candidates.splice(bestIdx, 1)[0]);
  }
  
  return selected;
}

function textSimilarity(a: string, b: string): number {
  // Simple Jaccard similarity on words
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}
```

### Token Budget Management

```typescript
// src/lib/tokens.ts

export function fitToTokenBudget(
  chunks: any[],
  maxTokens: number
): { chunks: any[]; totalTokens: number } {
  const result: any[] = [];
  let totalTokens = 0;
  
  for (const chunk of chunks) {
    const chunkTokens = estimateTokens(chunk.text);
    if (totalTokens + chunkTokens > maxTokens) break;
    
    result.push(chunk);
    totalTokens += chunkTokens;
  }
  
  return { chunks: result, totalTokens };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

## API Endpoints (Updated)

### Search Endpoints (require API key)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/search` | Smart search with automatic intent classification and routing |
| `GET` | `/api/documents` | List user's indexed documents |
| `GET` | `/api/documents/:id` | Get full document content |

### Internal Search Functions

These are called by `/api/search` based on classified intent - not exposed directly:

| Function | Intent | Techniques | Target Latency |
|----------|--------|------------|----------------|
| `retrieve()` | Lookup | Hybrid (BM25 heavy) | ~100ms |
| `discover()` | Explore | HyDE + multi-query + MMR | ~500ms |
| `gather()` | RAG | HyDE + multi-query + rerank | ~800ms |

### Request/Response Examples

**POST /api/search**
```json
// Request - simple query
{
  "query": "Q3 2024 budget spreadsheet"
}

// Response
{
  "intent": "retrieve",
  "results": [
    {
      "chunkId": "abc123",
      "documentId": "doc456",
      "documentTitle": "Q3 2024 Budget Planning",
      "documentUrl": "https://docs.google.com/document/d/...",
      "text": "The Q3 2024 budget allocates $150,000 to engineering...",
      "headingPath": "Budget Overview > Engineering",
      "score": 0.89
    }
  ],
  "timing": { 
    "classification": 28,
    "search": 95, 
    "total": 123 
  }
}
```

**POST /api/search (with context)**
```json
// Request - with context for better routing
{
  "query": "pricing strategy",
  "context": "I need to write a summary of our pricing approach for the board deck"
}

// Response - routed to gather() because context indicates synthesis task
{
  "intent": "gather",
  "results": {
    "chunks": [
      {
        "chunkId": "chunk1",
        "documentId": "doc1",
        "documentTitle": "Pricing Strategy 2024",
        "text": "Our current pricing model uses value-based pricing...",
        "headingPath": "Pricing Model",
        "score": 0.94
      }
    ],
    "sources": [
      {
        "documentId": "doc1",
        "documentTitle": "Pricing Strategy 2024",
        "documentUrl": "https://docs.google.com/...",
        "chunkCount": 3
      }
    ],
    "totalTokens": 2847,
    "confidence": "high",
    "queryVariations": [
      "pricing strategy",
      "This document outlines our pricing approach...",
      "pricing model value-based strategy"
    ]
  },
  "timing": { 
    "classification": 31,
    "search": 792, 
    "total": 823 
  }
}
```

**POST /api/search (exploratory)**
```json
// Request - exploratory language triggers discover
{
  "query": "What partnerships have we explored?"
}

// Response - routed to discover() based on query phrasing
{
  "intent": "discover",
  "results": [
    {
      "chunkId": "xyz789",
      "documentId": "doc123",
      "documentTitle": "Strategic Partnerships 2024",
      "documentUrl": "https://docs.google.com/document/d/...",
      "text": "We met with Acme Corp to discuss potential integration...",
      "headingPath": "Active Discussions > Acme Corp",
      "score": 0.82,
      "cluster": "Active Partnerships",
      "relationshipType": "similar topic"
    }
  ],
  "queryVariations": [
    "What partnerships have we explored?",
    "The document discusses several partnership opportunities...",
    "partnership exploration business development"
  ],
  "timing": { 
    "classification": 25,
    "search": 462, 
    "total": 487 
  }
}
```

## MCP Server (Updated)

### Tools

| Tool | Description |
|------|-------------|
| `search` | Intelligent search with automatic intent classification. Routes to optimal retrieval strategy. |
| `expand_document` | Get the full text of a document by ID. |
| `list_documents` | List all indexed documents with metadata. |

### Intent Classification

The `search` tool uses a lightweight LLM classifier to automatically route queries to the optimal retrieval strategy. This removes the burden from MCP clients of understanding the nuances between retrieval modes.

**Classification Model:** Llama 3.3 70B via Cerebras (ultra-fast inference, ~20-50ms)

**Intent Categories:**
- `retrieve`: User wants a specific document they know exists (lookup, finding something specific)
- `discover`: User wants to explore a topic, find connections, see what exists (browsing, exploration)
- `gather`: User needs comprehensive context to answer a question or complete a task (research, synthesis)

**How Context Improves Routing:**

| Query | Context | Classified Intent |
|-------|---------|-------------------|
| "pricing" | *(none)* | `retrieve` (default for ambiguous) |
| "pricing" | "I need to write a summary for a board deck" | `gather` |
| "pricing" | "what have we discussed about this over time?" | `discover` |
| "Q3 budget spreadsheet" | *(none)* | `retrieve` (specific item) |
| "what partnerships have we explored" | *(none)* | `discover` (exploratory language) |

### Tool Schemas

```typescript
// src/mcp/tools.ts

export const tools = [
  {
    name: 'search',
    description: 'Search your Google Drive documents. Describe what you\'re looking for and optionally why. The system automatically uses the best retrieval strategy based on your intent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { 
          type: 'string', 
          description: 'What you\'re searching for' 
        },
        context: { 
          type: 'string', 
          description: 'Optional: Why you need this - helps route to the best search strategy. Examples: "to answer a question about our budget", "to find that specific doc I saw last week", "to explore what we\'ve written about AI"'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'expand_document',
    description: 'Get the full text content of a document by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Document ID from search results' }
      },
      required: ['documentId']
    }
  },
  {
    name: 'list_documents',
    description: 'List all indexed documents with titles and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 50 },
        offset: { type: 'number', default: 0 }
      }
    }
  }
];
```

### Intent Classifier Implementation

Uses Vercel AI SDK with Cerebras provider for ultra-fast inference:

```typescript
// src/lib/intent-classifier.ts

import { generateText } from 'ai';
import { createCerebras } from '@ai-sdk/cerebras';

const cerebras = createCerebras({
  apiKey: process.env.CEREBRAS_API_KEY
});

export type SearchIntent = 'retrieve' | 'discover' | 'gather';

export async function classifySearchIntent(
  query: string, 
  context?: string
): Promise<SearchIntent> {
  const prompt = context 
    ? `Query: ${query}\nContext: ${context}` 
    : query;

  const { text } = await generateText({
    model: cerebras('llama-3.3-70b'),
    system: `Classify this search intent into exactly one category:
- "retrieve": User wants a specific document they know exists (lookup, finding something specific, mentions specific names/dates/titles)
- "discover": User wants to explore a topic, find connections, see what exists (browsing, exploration, "what have we...", "show me everything about...")
- "gather": User needs comprehensive context to answer a question or complete a task (research, synthesis, "I need to write...", "help me understand...")

Respond with only the category name, nothing else.`,
    prompt,
    maxTokens: 10,
    temperature: 0
  });

  const intent = text.trim().toLowerCase() as SearchIntent;
  
  // Validate and default to retrieve if unexpected response
  if (!['retrieve', 'discover', 'gather'].includes(intent)) {
    return 'retrieve';
  }
  
  return intent;
}
```

### Smart Search Router

```typescript
// src/lib/smart-search.ts

import { classifySearchIntent, SearchIntent } from './intent-classifier';
import { retrieve } from '../api/retrieve';
import { discover } from '../api/discover';
import { gather } from '../api/gather';

interface SmartSearchParams {
  query: string;
  context?: string;
}

interface SmartSearchResult {
  intent: SearchIntent;
  results: any;  // Type varies by intent
  timing: {
    classification: number;
    search: number;
    total: number;
  };
}

export async function smartSearch(
  userId: string,
  params: SmartSearchParams
): Promise<SmartSearchResult> {
  const startTime = Date.now();
  
  // 1. Classify intent (~20-50ms with Cerebras)
  const classifyStart = Date.now();
  const intent = await classifySearchIntent(params.query, params.context);
  const classifyTime = Date.now() - classifyStart;
  
  // 2. Route to appropriate search function
  const searchStart = Date.now();
  let results: any;
  
  switch (intent) {
    case 'retrieve':
      results = await retrieve(userId, { 
        query: params.query, 
        topK: 5 
      });
      break;
      
    case 'discover':
      results = await discover(userId, { 
        query: params.query, 
        topK: 10,
        diversityFactor: 0.3
      });
      break;
      
    case 'gather':
      results = await gather(userId, { 
        question: params.query, 
        thoroughness: 'balanced',
        maxTokens: 4000
      });
      break;
  }
  
  const searchTime = Date.now() - searchStart;
  
  return {
    intent,
    results,
    timing: {
      classification: classifyTime,
      search: searchTime,
      total: Date.now() - startTime
    }
  };
}
```

### MCP Server File Update (`/bin/mcp.js`)

The MCP server is a separate npm package at the repo root. Update it to use the new smart search:

```javascript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.GDRIVE_API_URL || "https://brkt-gdrive-mcp.vercel.app";
const API_KEY = process.env.GDRIVE_API_KEY;

if (!API_KEY) {
  console.error("Error: GDRIVE_API_KEY environment variable is required");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`,
};

async function search(query, context) {
  const response = await fetch(`${API_URL}/api/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, context }),
  });
  if (!response.ok) throw new Error(`Search failed: ${response.status}`);
  return response.json();
}

async function listDocuments() {
  const response = await fetch(`${API_URL}/api/documents`, { headers });
  if (!response.ok) throw new Error(`List failed: ${response.status}`);
  return response.json();
}

async function getDocument(id) {
  const response = await fetch(`${API_URL}/api/documents/${id}`, { headers });
  if (!response.ok) throw new Error(`Get document failed: ${response.status}`);
  return response.json();
}

async function main() {
  const server = new McpServer({
    name: "brkt-gdrive",
    version: "2.0.0",
  });

  // Smart search with intent classification
  server.tool(
    "search",
    "Search your Google Drive documents. The system automatically uses the best retrieval strategy based on your query and context.",
    {
      query: z.string().describe("What you're searching for"),
      context: z.string().optional().describe(
        "Optional: Why you need this - helps route to the best search strategy."
      ),
    },
    async ({ query, context }) => {
      const data = await search(query, context);
      
      const formattedResults = data.intent === "gather"
        ? [
            `**Intent:** ${data.intent} | **Confidence:** ${data.results.confidence}`,
            "",
            ...data.results.chunks.map((r, i) => 
              `### ${i + 1}. ${r.documentTitle}${r.headingPath ? ` > ${r.headingPath}` : ""}\n${r.text}`
            )
          ].join("\n")
        : [
            `**Intent:** ${data.intent}`,
            "",
            ...data.results.map((r, i) => 
              `### ${i + 1}. ${r.documentTitle}${r.headingPath ? ` > ${r.headingPath}` : ""}\n${r.text}`
            )
          ].join("\n");

      return { content: [{ type: "text", text: formattedResults }] };
    }
  );

  server.tool("list_documents", "List all indexed documents.", {}, async () => {
    const data = await listDocuments();
    const text = data.documents.map(d => `- **${d.title}** (${d.id})`).join("\n");
    return { content: [{ type: "text", text }] };
  });

  server.tool(
    "expand_document",
    "Get full document text by ID.",
    { document_id: z.string() },
    async ({ document_id }) => {
      const data = await getDocument(document_id);
      return { content: [{ type: "text", text: `# ${data.document.title}\n\n${data.document.full_text}` }] };
    }
  );

  await server.connect(new StdioServerTransport());
}

main().catch(console.error);
```

After updating, bump the version and publish:
```bash
# In root package.json, change version to "2.0.0"
npm publish
```

## Environment Variables (Updated)

```bash
# Existing
TURSO_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-turso-token
BETTER_AUTH_SECRET=your-auth-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
CRON_SECRET=your-cron-secret
ENCRYPTION_KEY=your-32-byte-encryption-key

# Updated
OPENAI_API_KEY=your-openai-key  # Still needed for HyDE (gpt-4o-mini)

# New
VOYAGE_API_KEY=your-voyage-key        # Embeddings
COHERE_API_KEY=your-cohere-key        # Reranking
CEREBRAS_API_KEY=your-cerebras-key    # Fast intent classification
```

## Migration Plan

### Overview

Single-day migration from v1.0 to v2.0. Since this is currently a single-user system, we can do a clean cutover without deprecation periods.

**Migration Steps:**

1. Install new packages
2. Set up new environment variables
3. Apply database schema changes
4. Deploy new code
5. Clear existing chunks and trigger full re-index
6. Verify everything works

---

### Step 1: Install New Packages

```bash
cd www
bun add ai @ai-sdk/openai @ai-sdk/cerebras
```

**Verification:** `bun run build` succeeds

---

### Step 2: Environment Variables

Add to Vercel dashboard (Settings → Environment Variables):

```bash
VOYAGE_API_KEY=...        # Get from https://dash.voyageai.com/
COHERE_API_KEY=...        # Get from https://dashboard.cohere.com/
CEREBRAS_API_KEY=...      # Get from https://cloud.cerebras.ai/
```

Also add to `www/.env.local` for local development.

**Verification:** All three keys accessible in Vercel functions

---

### Step 3: Database Schema Changes

Run these migrations against Turso (via Turso CLI or dashboard):

```sql
-- Add new columns to chunks
ALTER TABLE chunks ADD COLUMN heading_path TEXT;
ALTER TABLE chunks ADD COLUMN content_type TEXT DEFAULT 'prose';
ALTER TABLE chunks ADD COLUMN created_at TEXT DEFAULT (datetime('now'));

-- Add new columns to documents
ALTER TABLE documents ADD COLUMN has_headings INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN heading_structure TEXT;
ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0;

-- Create FTS5 virtual table for BM25 keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  heading_path,
  content='chunks',
  content_rowid='rowid'
);

-- Triggers to keep FTS5 in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading_path) 
  VALUES (NEW.rowid, NEW.text, NEW.heading_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path) 
  VALUES('delete', OLD.rowid, OLD.text, OLD.heading_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading_path) 
  VALUES('delete', OLD.rowid, OLD.text, OLD.heading_path);
  INSERT INTO chunks_fts(rowid, text, heading_path) 
  VALUES (NEW.rowid, NEW.text, NEW.heading_path);
END;
```

**Important:** Also update `www/src/db/schema.ts` to change the embedding dimension:

```typescript
// Change from:
embedding F32_BLOB(1536)

// To:
embedding F32_BLOB(1024)
```

**Verification:** 
- `SELECT * FROM chunks LIMIT 1` shows new columns
- `SELECT * FROM chunks_fts LIMIT 1` works (empty is fine)

---

### Step 4: Deploy New Code

Deploy the following new/updated files to `www/src/`:

**New files:**
- `lib/intent-classifier.ts` - Cerebras-based intent classification
- `lib/smart-search.ts` - Router that dispatches to retrieve/discover/gather
- `lib/fusion.ts` - Reciprocal Rank Fusion
- `lib/mmr.ts` - Maximal Marginal Relevance for diversity
- `lib/tokens.ts` - Token budget management
- `lib/hyde.ts` - HyDE hypothetical document generation
- `lib/rerank.ts` - Cohere reranking
- `search/retrieve.ts` - Fast lookup function
- `search/discover.ts` - Exploratory search function  
- `search/gather.ts` - RAG-optimized search function

**Updated files:**
- `app/api/search/route.ts` - Now uses smart search router
- `sync/google-drive.ts` - Add HTML export + parsing
- `sync/chunker.ts` - Structure-aware chunking
- `sync/embeddings.ts` - Voyage AI instead of OpenAI
- `sync/index.ts` - Use new chunker with HTML parsing
- `db/schema.ts` - New columns, FTS5 table, 1024d embeddings

**Also update MCP server** (`/bin/mcp.js`):
- Single `search` tool with `query` and optional `context` params

**Verification:** 
- `vercel deploy` succeeds
- `/api/search` endpoint responds (even with no data)

---

### Step 5: Clear and Re-index

```sql
-- Clear existing chunks (embeddings are incompatible)
DELETE FROM chunks;

-- Clear FTS5 index  
DELETE FROM chunks_fts;

-- Reset document chunk counts
UPDATE documents SET chunk_count = 0;
```

Then trigger a full re-sync. Either:

**Option A: Via dashboard**
Go to your dashboard and click "Sync Now"

**Option B: Via API**
```bash
curl -X POST https://your-app.vercel.app/api/sync/trigger \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"fullResync": true}'
```

**Option C: Local script**
```bash
cd www
bun run sync
```

**Monitor the sync:**
- Watch Vercel function logs for errors
- Check for rate limit issues (Voyage has generous limits)
- Verify chunks are being created with 1024-dimension embeddings

**Verification:**
```sql
-- Check chunks exist with new embedding size
SELECT COUNT(*) FROM chunks;
SELECT LENGTH(embedding) FROM chunks LIMIT 1;  -- Should be 4096 bytes (1024 floats × 4 bytes)

-- Check FTS5 is populated
SELECT COUNT(*) FROM chunks_fts;
```

---

### Step 6: Functional Verification

Test each intent path:

**Retrieve (specific lookup):**
```bash
curl -X POST https://your-app.vercel.app/api/search \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "Q3 budget"}'
```
Expected: `"intent": "retrieve"`, fast response (~100-150ms)

**Discover (exploration):**
```bash
curl -X POST https://your-app.vercel.app/api/search \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "What have we written about partnerships?"}'
```
Expected: `"intent": "discover"`, diverse results, ~500ms

**Gather (with context):**
```bash
curl -X POST https://your-app.vercel.app/api/search \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "pricing strategy", "context": "I need to write a summary for the board"}'
```
Expected: `"intent": "gather"`, reranked results, ~800ms

**MCP Server:**
```bash
# Test with Claude Desktop or similar
# Should see single "search" tool with query + context params
```

---

### Rollback Plan

If something goes wrong:

1. **Revert code:** `vercel rollback` to previous deployment
2. **Keep data:** The chunks table structure is backward-compatible
3. **Re-embed with OpenAI:** Change `embeddings.ts` back to OpenAI and re-sync

The FTS5 table and new columns won't break v1.0 code - they'll just be ignored.

## File Structure (Updated)

```
brkt-gdrive-mcp/
├── SPEC.md                    # Archived v1.0 spec
├── SPEC-2.0.md                # This document
├── package.json               # MCP package entry point
├── bin/
│   └── mcp.js                 # MCP server (npm package)
├── www/                       # Next.js web app
│   ├── package.json
│   ├── next.config.ts
│   ├── vercel.json
│   └── src/
│       ├── app/
│       │   ├── api/
│       │   │   ├── auth/
│       │   │   │   └── [...all]/route.ts
│       │   │   ├── documents/
│       │   │   │   ├── route.ts
│       │   │   │   └── [id]/route.ts
│       │   │   ├── keys/
│       │   │   │   ├── route.ts
│       │   │   │   └── [id]/route.ts
│       │   │   ├── oauth/
│       │   │   │   └── google/route.ts
│       │   │   ├── search/
│       │   │   │   └── route.ts       # UPDATED: Smart search with intent classification
│       │   │   ├── me/
│       │   │   │   ├── status/route.ts
│       │   │   │   └── sync/route.ts
│       │   │   └── sync/
│       │   │       └── trigger/route.ts
│       │   ├── dashboard/page.tsx
│       │   ├── login/page.tsx
│       │   ├── signup/page.tsx
│       │   ├── layout.tsx
│       │   └── page.tsx
│       ├── auth/
│       │   └── index.ts
│       ├── db/
│       │   ├── client.ts
│       │   ├── schema.ts              # UPDATED: New columns + FTS5
│       │   └── auth-schema.ts
│       ├── lib/
│       │   ├── api-keys.ts
│       │   ├── auth-client.ts
│       │   ├── auth-helper.ts
│       │   ├── intent-classifier.ts   # NEW: Cerebras-based routing
│       │   ├── smart-search.ts        # NEW: Router to retrieve/discover/gather
│       │   ├── fusion.ts              # NEW: RRF implementation
│       │   ├── mmr.ts                 # NEW: Diversity scoring
│       │   ├── tokens.ts              # NEW: Budget management
│       │   ├── hyde.ts                # NEW: Hypothetical document generation
│       │   └── rerank.ts              # NEW: Cohere reranking
│       ├── search/                    # NEW: Internal search functions
│       │   ├── retrieve.ts
│       │   ├── discover.ts
│       │   └── gather.ts
│       └── sync/
│           ├── index.ts
│           ├── google-drive.ts        # UPDATED: Export as HTML for structure
│           ├── chunker.ts             # UPDATED: Structure-aware chunking
│           └── embeddings.ts          # UPDATED: Voyage AI
└── .github/
    └── workflows/
        └── sync.yml
```

## Cost Estimates (Monthly)

Assuming 10,000 documents, 100,000 chunks, 10,000 searches/month:

| Service | Usage | Cost |
|---------|-------|------|
| **Voyage AI** | ~25M tokens (index) + 1M tokens (queries) | ~$1.50 (free tier covers this) |
| **Cohere Rerank** | ~3,000 gather() calls | ~$6 |
| **OpenAI (HyDE)** | ~7,000 calls (discover + gather) | ~$1 |
| **Cerebras** | ~10,000 classifications | ~$0.01 (negligible) |
| **Turso** | Free tier | $0 |
| **Vercel** | Free tier | $0 |
| **Total** | | **~$7-10/month** |

## Future Considerations

- **Hierarchical chunking**: Parent-child retrieval for better context
- **Custom reranker fine-tuning**: Train on user feedback
- **Query intent classification**: Auto-route to retrieve/discover/gather
- **Caching layer**: Cache HyDE results for common query patterns
- **Analytics dashboard**: Track search quality, latency, costs
- **Real-time indexing**: Google Drive webhooks for instant updates
