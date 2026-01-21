import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth-helper";
import { db } from "@/db/client";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// MCP Protocol version
const PROTOCOL_VERSION = "2024-11-05";

// Tool definitions
const TOOLS = [
  {
    name: "search",
    description: "Semantic search over your Google Drive documents. Returns relevant text chunks with source information.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (1-50, default 10)",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_documents",
    description: "List all indexed Google Drive documents with metadata (title, last modified, etc).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "expand_document",
    description: "Get the full text content of a document by its ID. Use this after searching to get complete document context.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "The document ID to retrieve",
        },
      },
      required: ["document_id"],
    },
  },
];

// Tool implementations
async function executeSearch(userId: string, query: string, limit: number = 10) {
  // Generate embedding for the query
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryEmbedding = embeddingResponse.data[0]!.embedding;

  // Vector search (filtered by user_id)
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

  if (results.length === 0) {
    return "No matching documents found.";
  }

  return results.map((r, i) => {
    return `## Result ${i + 1}: ${r.document_title}
**Document ID:** ${r.document_id}
**Similarity:** ${(r.similarity * 100).toFixed(1)}%

${r.chunk_text}

---`;
  }).join("\n\n");
}

async function executeListDocuments(userId: string) {
  const result = await db.execute({
    sql: `SELECT id, title, google_modified_time FROM documents WHERE user_id = ? ORDER BY title`,
    args: [userId],
  });

  const documents = result.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    google_modified_time: row.google_modified_time as string,
  }));

  if (documents.length === 0) {
    return "No documents indexed yet.";
  }

  const formattedList = documents.map((doc) => {
    return `- **${doc.title}**
  - ID: ${doc.id}
  - Last modified: ${doc.google_modified_time}`;
  });

  return `# Indexed Documents (${documents.length} total)\n\n${formattedList.join("\n")}`;
}

async function executeExpandDocument(userId: string, documentId: string) {
  const result = await db.execute({
    sql: `SELECT id, title, full_text, google_modified_time FROM documents WHERE id = ? AND user_id = ?`,
    args: [documentId, userId],
  });

  if (result.rows.length === 0) {
    throw new Error(`Document not found: ${documentId}`);
  }

  const doc = result.rows[0]!;
  return `# ${doc.title}

**Last modified:** ${doc.google_modified_time}

---

${doc.full_text}`;
}

// JSON-RPC response helpers
function jsonRpcSuccess(id: string | number | null, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined && { data }),
    },
  };
}

/**
 * MCP HTTP Endpoint
 * Implements MCP protocol over HTTP using JSON-RPC 2.0
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate the request
    const userId = await getAuthenticatedUserId(request);
    if (!userId) {
      return NextResponse.json(
        jsonRpcError(null, -32000, "Unauthorized"),
        { status: 401 }
      );
    }

    const body = await request.json();
    const { jsonrpc, id, method, params } = body;

    // Validate JSON-RPC format
    if (jsonrpc !== "2.0") {
      return NextResponse.json(
        jsonRpcError(id, -32600, "Invalid Request: jsonrpc must be '2.0'")
      );
    }

    // Handle methods
    switch (method) {
      case "initialize": {
        return NextResponse.json(
          jsonRpcSuccess(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "brkt-gdrive",
              version: "1.0.0",
            },
          })
        );
      }

      case "notifications/initialized": {
        // Client notification that initialization is complete
        return NextResponse.json(jsonRpcSuccess(id, {}));
      }

      case "tools/list": {
        return NextResponse.json(
          jsonRpcSuccess(id, {
            tools: TOOLS,
          })
        );
      }

      case "tools/call": {
        const { name, arguments: args } = params || {};

        if (!name) {
          return NextResponse.json(
            jsonRpcError(id, -32602, "Invalid params: tool name required")
          );
        }

        try {
          let result: string;

          switch (name) {
            case "search": {
              const { query, limit = 10 } = args || {};
              if (!query) {
                return NextResponse.json(
                  jsonRpcError(id, -32602, "Invalid params: query required")
                );
              }
              result = await executeSearch(userId, query, limit);
              break;
            }

            case "list_documents": {
              result = await executeListDocuments(userId);
              break;
            }

            case "expand_document": {
              const { document_id } = args || {};
              if (!document_id) {
                return NextResponse.json(
                  jsonRpcError(id, -32602, "Invalid params: document_id required")
                );
              }
              result = await executeExpandDocument(userId, document_id);
              break;
            }

            default:
              return NextResponse.json(
                jsonRpcError(id, -32601, `Unknown tool: ${name}`)
              );
          }

          return NextResponse.json(
            jsonRpcSuccess(id, {
              content: [
                {
                  type: "text",
                  text: result,
                },
              ],
            })
          );
        } catch (toolError: unknown) {
          const errorMessage = toolError instanceof Error ? toolError.message : "Tool execution failed";
          return NextResponse.json(
            jsonRpcSuccess(id, {
              content: [
                {
                  type: "text",
                  text: `Error: ${errorMessage}`,
                },
              ],
              isError: true,
            })
          );
        }
      }

      case "ping": {
        return NextResponse.json(jsonRpcSuccess(id, {}));
      }

      default:
        return NextResponse.json(
          jsonRpcError(id, -32601, `Method not found: ${method}`)
        );
    }
  } catch (error) {
    console.error("MCP endpoint error:", error);
    return NextResponse.json(
      jsonRpcError(null, -32603, "Internal error"),
      { status: 500 }
    );
  }
}

// Handle preflight requests for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
