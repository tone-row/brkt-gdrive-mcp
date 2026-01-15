# brkt-gdrive-mcp

MCP server for semantic search over your Google Drive documents. Works with Claude Desktop, Cursor, and other MCP-compatible AI tools.

## Setup

1. **Get an API key** at [brkt-gdrive-mcp.vercel.app](https://brkt-gdrive-mcp.vercel.app)
   - Sign up and connect your Google Drive
   - Sync your documents
   - Generate an API key

2. **Configure your MCP client**

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gdrive-search": {
      "command": "npx",
      "args": ["github:tone-row/brkt-gdrive-mcp"],
      "env": {
        "GDRIVE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Cursor

Add to your MCP settings:

```json
{
  "mcpServers": {
    "gdrive-search": {
      "command": "npx",
      "args": ["github:tone-row/brkt-gdrive-mcp"],
      "env": {
        "GDRIVE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search` | Semantic search over your Google Drive documents |
| `list_documents` | List all indexed documents with metadata |
| `expand_document` | Get full text content of a document by ID |

## Repository Structure

```
brkt-gdrive-mcp/
├── bin/mcp.js       # MCP server (this package)
├── www/             # Web app (brkt-gdrive-mcp.vercel.app)
└── package.json     # MCP package manifest
```

## License

MIT
