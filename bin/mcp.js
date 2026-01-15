#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const API_URL = process.env.GDRIVE_API_URL || "https://brkt-gdrive-mcp.vercel.app";
const API_KEY = process.env.GDRIVE_API_KEY;

if (!API_KEY) {
  console.error("Error: GDRIVE_API_KEY environment variable is required");
  console.error("Get your API key at: https://brkt-gdrive-mcp.vercel.app");
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
      query: {
        type: "string",
        description: "The search query",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (1-50, default 10)",
      },
    },
    async ({ query, limit = 10 }) => {
      const results = await search(query, Math.min(Math.max(limit, 1), 50));

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
      document_id: {
        type: "string",
        description: "The document ID to retrieve",
      },
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
