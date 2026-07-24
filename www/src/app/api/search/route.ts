import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth-helper";
import { db } from "@/db/client";
import { searchV2 } from "@/lib/search-v2";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Fail fast instead of grinding to the platform default and feeding client
// retry pile-ups; DB requests are individually capped at 25s in db/client.ts.
export const maxDuration = 60;

// Feature flag to use new V2 vector table
// Set USE_NEW_VECTOR_TABLE=true in environment to enable
const USE_NEW_VECTOR_TABLE = process.env.USE_NEW_VECTOR_TABLE === "true";

export async function POST(request: NextRequest) {
  try {
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { query, limit = 10 } = body as { query?: string; limit?: number };

    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    // Generate embedding for the query
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = embeddingResponse.data[0]!.embedding;

    if (USE_NEW_VECTOR_TABLE) {
      // V2 search: deduplicated documents with user access mapping
      const results = await searchV2(userId, queryEmbedding, limit);
      return NextResponse.json({ results });
    }

    // Original search: filtered by user_id on chunks table
    const result = await db.execute({
      sql: `
        SELECT
          c.document_id,
          d.title as document_title,
          c.chunk_index,
          c.text as chunk_text,
          vector_distance_cos(c.embedding, vector(?)) as distance
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.user_id = ?
        ORDER BY distance ASC
        LIMIT ?
      `,
      args: [`[${queryEmbedding.join(",")}]`, userId, limit],
    });

    const results = result.rows.map((row) => ({
      document_id: row.document_id as string,
      document_title: row.document_title as string,
      chunk_index: row.chunk_index as number,
      chunk_text: row.chunk_text as string,
      similarity: 1 - (row.distance as number),
    }));

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
