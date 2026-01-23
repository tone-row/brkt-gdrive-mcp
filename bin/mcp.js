#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Support both GDRIVE_API_KEY (new) and GDRIVE_MCP_URL (URL with key embedded)
let API_URL = process.env.GDRIVE_API_URL || "https://brkt-gdrive-mcp.vercel.app";
let API_KEY = process.env.GDRIVE_API_KEY;

// Check if GDRIVE_MCP_URL is provided (URL with key embedded, e.g., https://app.com/mcp?key=gd_xxx)
const MCP_URL = process.env.GDRIVE_MCP_URL;
if (MCP_URL) {
  try {
    const url = new URL(MCP_URL);
    const keyFromUrl = url.searchParams.get("key");
    if (keyFromUrl) {
      API_KEY = keyFromUrl;
      // Remove the /mcp path and query params to get the base URL
      API_URL = `${url.protocol}//${url.host}`;
    }
  } catch (e) {
    console.error("Error: Invalid GDRIVE_MCP_URL format");
    process.exit(1);
  }
}

if (!API_KEY) {
  console.error("Error: GDRIVE_API_KEY or GDRIVE_MCP_URL environment variable is required");
  console.error("Get your credentials at: https://brkt-gdrive-mcp.vercel.app");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`,
};

async function search(query, limit = 10) {
  const response = await fetch(`${API_URL}/api/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, limit }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Search failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.results;
}

async function listDocuments() {
  const response = await fetch(`${API_URL}/api/documents`, { headers });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`List documents failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.documents;
}

async function getDocument(id) {
  const response = await fetch(`${API_URL}/api/documents/${id}`, { headers });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Document not found: ${id}`);
    }
    const error = await response.text();
    throw new Error(`Get document failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.document;
}

async function main() {
  const server = new McpServer({
    name: "brkt-gdrive",
    version: "1.0.0",
  });

  // Register search tool
  server.tool(
    "search",
    "Semantic search over your Google Drive documents. Returns relevant text chunks with source information.",
    {
      query: z.string().describe("The search query"),
      limit: z.number().min(1).max(50).default(10).describe("Maximum number of results to return"),
    },
    async ({ query, limit }) => {
      const results = await search(query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No matching documents found.",
            },
          ],
        };
      }

      const formattedResults = results.map((r, i) => {
        return `## Result ${i + 1}: ${r.document_title}
**Document ID:** ${r.document_id}
**Similarity:** ${(r.similarity * 100).toFixed(1)}%

${r.chunk_text}

---`;
      });

      return {
        content: [
          {
            type: "text",
            text: formattedResults.join("\n\n"),
          },
        ],
      };
    }
  );

  // Register list_documents tool
  server.tool(
    "list_documents",
    "List all indexed Google Drive documents with metadata (title, last modified, etc).",
    {},
    async () => {
      const documents = await listDocuments();

      if (documents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No documents indexed yet.",
            },
          ],
        };
      }

      const formattedList = documents.map((doc) => {
        return `- **${doc.title}**
  - ID: ${doc.id}
  - Last modified: ${doc.google_modified_time}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `# Indexed Documents (${documents.length} total)\n\n${formattedList.join("\n")}`,
          },
        ],
      };
    }
  );

  // Register expand_document tool
  server.tool(
    "expand_document",
    "Get the full text content of a document by its ID. Use this after searching to get complete document context.",
    {
      document_id: z.string().describe("The document ID to retrieve"),
    },
    async ({ document_id }) => {
      const doc = await getDocument(document_id);

      return {
        content: [
          {
            type: "text",
            text: `# ${doc.title}

**Last modified:** ${doc.google_modified_time}

---

${doc.full_text}`,
          },
        ],
      };
    }
  );

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
