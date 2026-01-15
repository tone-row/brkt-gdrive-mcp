import index from "./index.html";
import { auth } from "./src/auth";
import { db } from "./src/db/client";
import { syncUserById } from "./src/sync";
import {
  generateApiKey,
  validateApiKey,
  listApiKeys,
  deleteApiKey,
} from "./src/lib/api-keys";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Helper to get the current user from session (for web app)
 */
async function getCurrentUser(req: Request): Promise<{ id: string; email: string } | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email };
}

/**
 * Helper to get user from API key (for MCP server)
 * Checks Authorization header for "Bearer <api-key>"
 */
async function getUserFromApiKey(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const apiKey = authHeader.slice(7);
  return validateApiKey(apiKey);
}

/**
 * Helper to get user from either session or API key
 * Returns user ID or null
 */
async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  // Try session auth first
  const user = await getCurrentUser(req);
  if (user) return user.id;

  // Fall back to API key auth
  return getUserFromApiKey(req);
}

Bun.serve({
  port: 3000,
  routes: {
    "/": index,
    "/login": index,
    "/signup": index,
    "/dashboard": index,

    // Better Auth routes
    "/api/auth/*": async (req) => {
      return auth.handler(req);
    },

    // API Key management
    "/api/keys": {
      // Create a new API key
      POST: async (req) => {
        try {
          const user = await getCurrentUser(req);
          if (!user) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          const body = await req.json();
          const { name } = body as { name?: string };

          if (!name || typeof name !== "string" || name.trim().length === 0) {
            return Response.json({ error: "Name is required" }, { status: 400 });
          }

          const result = await generateApiKey(user.id, name.trim());

          return Response.json({
            id: result.id,
            key: result.key, // Only returned once!
            prefix: result.prefix,
            name: name.trim(),
            createdAt: result.createdAt,
          });
        } catch (error) {
          console.error("Create API key error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },

      // List all API keys for the current user
      GET: async (req) => {
        try {
          const user = await getCurrentUser(req);
          if (!user) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          const keys = await listApiKeys(user.id);

          return Response.json({ keys });
        } catch (error) {
          console.error("List API keys error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },
    },

    // Delete an API key
    "/api/keys/:id": {
      DELETE: async (req) => {
        try {
          const user = await getCurrentUser(req);
          if (!user) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          const keyId = req.params.id;
          const deleted = await deleteApiKey(user.id, keyId);

          if (!deleted) {
            return Response.json({ error: "API key not found" }, { status: 404 });
          }

          return Response.json({ success: true });
        } catch (error) {
          console.error("Delete API key error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },
    },

    // User status (connection status, doc count, etc.)
    "/api/me/status": {
      GET: async (req) => {
        try {
          const user = await getCurrentUser(req);
          if (!user) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          // Check if user has Google account connected
          const accountResult = await db.execute({
            sql: `SELECT id, access_token FROM accounts WHERE user_id = ? AND provider_id = 'google'`,
            args: [user.id],
          });
          const hasGoogleConnected = accountResult.rows.length > 0 && accountResult.rows[0]!.access_token;

          // Get document count
          const docResult = await db.execute({
            sql: `SELECT COUNT(*) as count FROM documents WHERE user_id = ?`,
            args: [user.id],
          });
          const documentCount = docResult.rows[0]?.count as number || 0;

          // Get chunk count
          const chunkResult = await db.execute({
            sql: `SELECT COUNT(*) as count FROM chunks WHERE user_id = ?`,
            args: [user.id],
          });
          const chunkCount = chunkResult.rows[0]?.count as number || 0;

          return Response.json({
            googleConnected: !!hasGoogleConnected,
            documentCount,
            chunkCount,
          });
        } catch (error) {
          console.error("Status error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },
    },

    // Trigger sync for current user
    "/api/me/sync": {
      POST: async (req) => {
        try {
          const user = await getCurrentUser(req);
          if (!user) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          console.log(`Manual sync triggered for user: ${user.email}`);
          const result = await syncUserById(user.id);

          return Response.json({
            success: true,
            added: result.added,
            updated: result.updated,
            deleted: result.deleted,
          });
        } catch (error: any) {
          console.error("Sync error:", error);
          return Response.json({ error: error.message || "Sync failed" }, { status: 500 });
        }
      },
    },

    // Search API (user-scoped, supports both session and API key auth)
    "/api/search": {
      POST: async (req) => {
        try {
          const userId = await getAuthenticatedUserId(req);
          if (!userId) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          const body = await req.json();
          const { query, limit = 10 } = body as { query?: string; limit?: number };

          if (!query || typeof query !== "string") {
            return Response.json({ error: "Query is required" }, { status: 400 });
          }

          // Generate embedding for the query
          const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: query,
          });
          const queryEmbedding = embeddingResponse.data[0]!.embedding;

          // Vector search (filtered by user_id on chunks table)
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

          return Response.json({ results });
        } catch (error) {
          console.error("Search error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },
    },

    // Documents API (user-scoped, supports both session and API key auth)
    "/api/documents": {
      GET: async (req) => {
        try {
          const userId = await getAuthenticatedUserId(req);
          if (!userId) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          const result = await db.execute({
            sql: `
              SELECT id, google_doc_id, title, google_modified_time, created_at, updated_at
              FROM documents
              WHERE user_id = ?
              ORDER BY updated_at DESC
            `,
            args: [userId],
          });

          const documents = result.rows.map((row) => ({
            id: row.id as string,
            google_doc_id: row.google_doc_id as string,
            title: row.title as string,
            google_modified_time: row.google_modified_time as string,
            created_at: row.created_at as string,
            updated_at: row.updated_at as string,
          }));

          return Response.json({ documents });
        } catch (error) {
          console.error("List documents error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },
    },

    "/api/documents/:id": {
      GET: async (req) => {
        try {
          const userId = await getAuthenticatedUserId(req);
          if (!userId) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }

          const id = req.params.id;

          const result = await db.execute({
            sql: `
              SELECT id, google_doc_id, title, full_text, google_modified_time, created_at, updated_at
              FROM documents
              WHERE id = ? AND user_id = ?
            `,
            args: [id, userId],
          });

          if (result.rows.length === 0) {
            return Response.json({ error: "Document not found" }, { status: 404 });
          }

          const row = result.rows[0]!;
          const document = {
            id: row.id as string,
            google_doc_id: row.google_doc_id as string,
            title: row.title as string,
            full_text: row.full_text as string,
            google_modified_time: row.google_modified_time as string,
            created_at: row.created_at as string,
            updated_at: row.updated_at as string,
          };

          return Response.json({ document });
        } catch (error) {
          console.error("Get document error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
        }
      },
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log("Server running at http://localhost:3000");
