import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth-helper";
import { db } from "@/db/client";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

    let result;

    if (USE_NEW_VECTOR_TABLE) {
      // V2 search: Use deduplicated documents with user access mapping
      result = await db.execute({
        sql: `
          SELECT
            dv.document_id,
            d.title as document_title,
            dv.chunk_index,
            dv.text as chunk_text,
            vector_distance_cos(dv.embedding, vector(?)) as distance
          FROM document_vectors dv
          JOIN documents_v2 d ON d.id = dv.document_id
          JOIN user_document_access uda ON uda.document_id = d.id
          WHERE uda.user_id = ?
          ORDER BY distance ASC
          LIMIT ?
        `,
        args: [`[${queryEmbedding.join(",")}]`, userId, limit],
      });
    } else {
      // Original search: filtered by user_id on chunks table
      result = await db.execute({
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
    }

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
