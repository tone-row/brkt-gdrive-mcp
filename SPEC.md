# Google Drive Vector Search MCP

Vector search over Google Drive documents, exposed via an MCP server.

> **Architecture Pivot (January 2025):** This project originally used a service account approach for a single organization's Google Drive. We pivoted to a multi-tenant OAuth approach because:
> 1. Service accounts require Google Workspace admin approval, which is a blocker for many organizations
> 2. OAuth allows users to authenticate themselves without admin involvement
> 3. Multi-tenant architecture enables this to be a product anyone can use
>
> The trade-off is increased complexity (user accounts, token storage, multi-tenant data), but it's more scalable and user-friendly.

## Overview

This project enables semantic search over Google Docs for any user who connects their Google account. It consists of four components:

1. **Web App** - Frontend for user authentication and Google OAuth connection
2. **API Server** - Vercel-hosted API that handles search queries, document retrieval, and OAuth
3. **Sync Job** - GitHub Actions workflow that syncs all users' Google Drives to the vector database
4. **MCP Server** - npm package that exposes the API to MCP clients (Claude Desktop, Cursor, etc.)

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
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
   │    Turso    │       │   OpenAI    │       │ Google APIs │
   │  (vectors)  │       │ (embeddings)│       │ (OAuth/Drive)│
   └─────────────┘       └─────────────┘       └─────────────┘
```

## Authentication Flow

### User Registration/Login (Better Auth)
1. User visits web app
2. Signs up/logs in via Better Auth (email/password or social providers)
3. Better Auth creates session, stores user in `users` table

### Google Drive Connection (OAuth 2.0)
1. Authenticated user clicks "Connect Google Drive"
2. Redirected to Google OAuth consent screen
3. User grants `drive.readonly` scope
4. Callback receives authorization code
5. Exchange code for access token + refresh token
6. Store encrypted refresh token in `google_connections` table
7. User can now sync their Google Drive

### MCP Server Authentication
1. User generates an API key from the web app
2. API key stored (hashed) in `api_keys` table
3. User configures MCP server with their API key
4. All MCP requests include the API key for user identification

## Components

### 1. Web App (Frontend)

Simple frontend for authentication and account management.

**Pages:**
- `/` - Landing page with "Get Started" CTA
- `/login` - Better Auth login
- `/signup` - Better Auth registration
- `/dashboard` - Connect Google Drive, view sync status, manage API keys

**Tech Stack:**
- React (via Bun's HTML imports)
- Better Auth client
- Tailwind CSS

### 2. API Server (Vercel)

Hosted on Vercel. Handles authentication, OAuth, search, and document operations.

**Auth Endpoints (Better Auth):**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/*` | Better Auth handlers (login, signup, session, etc.) |

**OAuth Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/oauth/google` | Initiate Google OAuth flow |
| `GET` | `/api/oauth/google/callback` | Handle OAuth callback, store tokens |
| `DELETE` | `/api/oauth/google` | Disconnect Google Drive |

**API Key Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/keys` | Generate new API key |
| `GET` | `/api/keys` | List user's API keys |
| `DELETE` | `/api/keys/:id` | Revoke an API key |

**Search Endpoints (require API key):**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/search` | Vector search over user's documents |
| `GET` | `/api/documents` | List user's indexed documents |
| `GET` | `/api/documents/:id` | Get full document content |

**Sync Endpoints (internal, require cron secret):**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sync/trigger` | Trigger sync for all users (called by cron) |

**Environment Variables:**
- `TURSO_URL` - Turso database URL
- `TURSO_AUTH_TOKEN` - Turso auth token
- `OPENAI_API_KEY` - For embedding search queries
- `BETTER_AUTH_SECRET` - Better Auth secret key
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `CRON_SECRET` - Secret for authenticating cron job requests
- `ENCRYPTION_KEY` - For encrypting stored OAuth refresh tokens

### 3. Sync Job (GitHub Actions)

Runs on a schedule (twice daily) to keep all users' documents in sync.

**Process:**
1. Call `/api/sync/trigger` with `CRON_SECRET`
2. API fetches all users with connected Google accounts
3. For each user:
   - Use their stored refresh token to get a fresh access token
   - Fetch list of all Google Docs they have access to
   - Compare against their last sync state
   - Process new/updated/deleted documents
   - Update user's sync state timestamp
4. Handle token refresh failures (mark connection as needing re-auth)

**GitHub Secrets Required:**
- `API_URL` - Vercel deployment URL
- `CRON_SECRET` - Matches the API's `CRON_SECRET`

### 4. MCP Server (npm package)

Published as `brkt-gdrive-mcp` on npm. Thin client that calls the API with user's API key.

**Tools:**

| Tool | Description |
|------|-------------|
| `search` | Semantic search over your documents. Returns relevant chunks with source info. |
| `expand_document` | Get the full text of a document by ID. |
| `list_documents` | List all your indexed documents with metadata. |

**Configuration:**
```json
{
  "mcpServers": {
    "gdrive-search": {
      "command": "npx",
      "args": ["brkt-gdrive-mcp"],
      "env": {
        "GDRIVE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Database Schema (Turso + libsql-vector)

### `users` (Better Auth)
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID |
| `email` | TEXT UNIQUE | User's email |
| `email_verified` | INTEGER | Whether email is verified |
| `name` | TEXT | User's display name |
| `image` | TEXT | Profile image URL |
| `created_at` | TEXT | Account creation time |
| `updated_at` | TEXT | Last update time |

### `sessions` (Better Auth)
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Session ID |
| `user_id` | TEXT | FK to users.id |
| `token` | TEXT UNIQUE | Session token |
| `expires_at` | TEXT | Session expiration |
| `ip_address` | TEXT | Client IP |
| `user_agent` | TEXT | Client user agent |
| `created_at` | TEXT | Session creation time |
| `updated_at` | TEXT | Last update time |

### `accounts` (Better Auth - for social logins)
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Account ID |
| `user_id` | TEXT | FK to users.id |
| `account_id` | TEXT | Provider's account ID |
| `provider_id` | TEXT | Provider name (e.g., "google") |
| `access_token` | TEXT | OAuth access token |
| `refresh_token` | TEXT | OAuth refresh token |
| `access_token_expires_at` | TEXT | Token expiration |
| `scope` | TEXT | Granted scopes |
| `created_at` | TEXT | Connection time |
| `updated_at` | TEXT | Last update time |

### `api_keys`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID |
| `user_id` | TEXT | FK to users.id |
| `name` | TEXT | User-provided name for the key |
| `key_hash` | TEXT UNIQUE | SHA-256 hash of the API key |
| `key_prefix` | TEXT | First 8 chars for identification |
| `last_used_at` | TEXT | Last time key was used |
| `created_at` | TEXT | When key was created |

### `google_connections`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID |
| `user_id` | TEXT UNIQUE | FK to users.id (one connection per user) |
| `google_email` | TEXT | Google account email |
| `refresh_token_encrypted` | TEXT | Encrypted OAuth refresh token |
| `scopes` | TEXT | Granted OAuth scopes |
| `connected_at` | TEXT | When connection was established |
| `last_sync_at` | TEXT | Last successful sync |
| `sync_status` | TEXT | "active", "needs_reauth", "error" |
| `sync_error` | TEXT | Error message if sync failed |

### `documents`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID |
| `user_id` | TEXT | FK to users.id |
| `google_doc_id` | TEXT | Google Drive file ID |
| `title` | TEXT | Document title |
| `full_text` | TEXT | Full document content |
| `google_modified_time` | TEXT | ISO timestamp from Google |
| `created_at` | TEXT | When we first indexed it |
| `updated_at` | TEXT | When we last updated it |

*Unique constraint on (user_id, google_doc_id)*

### `chunks`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID |
| `document_id` | TEXT | FK to documents.id |
| `user_id` | TEXT | FK to users.id (denormalized for efficient vector search) |
| `chunk_index` | INTEGER | Position in document |
| `text` | TEXT | Chunk content |
| `embedding` | F32_BLOB(1536) | Vector embedding |

*Note: `user_id` is denormalized from documents to enable filtered vector search. Without this, we'd have to join through documents for every vector query, which is inefficient for multi-tenant search.*

## Chunking Strategy

- **Chunk size**: ~500-1000 tokens
- **Overlap**: ~100 tokens
- **Method**: Split on paragraph boundaries where possible, fall back to sentence boundaries

## Embedding Model

- **Model**: OpenAI `text-embedding-3-small`
- **Dimensions**: 1536

## File Structure

```
brkt-gdrive-mcp/
├── SPEC.md
├── package.json
├── index.html                 # Main HTML entry point
├── frontend/
│   ├── App.tsx               # Main React app
│   ├── pages/
│   │   ├── Landing.tsx
│   │   ├── Login.tsx
│   │   ├── Signup.tsx
│   │   └── Dashboard.tsx
│   ├── components/
│   │   ├── GoogleConnectButton.tsx
│   │   ├── ApiKeyManager.tsx
│   │   └── SyncStatus.tsx
│   └── lib/
│       └── auth-client.ts    # Better Auth client
├── api/                       # Vercel API routes
│   ├── auth/
│   │   └── [...all].ts       # Better Auth catch-all
│   ├── oauth/
│   │   └── google/
│   │       ├── index.ts      # Initiate OAuth
│   │       └── callback.ts   # Handle callback
│   ├── keys/
│   │   ├── index.ts          # Create/list keys
│   │   └── [id].ts           # Delete key
│   ├── search.ts
│   ├── documents/
│   │   ├── index.ts
│   │   └── [id].ts
│   └── sync/
│       └── trigger.ts        # Cron endpoint
├── src/
│   ├── db/
│   │   ├── schema.ts         # Database schema + migrations
│   │   └── client.ts         # Turso client
│   ├── auth/
│   │   └── index.ts          # Better Auth configuration
│   ├── sync/
│   │   ├── index.ts          # Main sync logic
│   │   ├── google-drive.ts   # Google Drive API client (OAuth-based)
│   │   ├── chunker.ts        # Text chunking logic
│   │   └── embeddings.ts     # OpenAI embeddings client
│   ├── lib/
│   │   ├── encryption.ts     # Token encryption utilities
│   │   └── api-keys.ts       # API key generation/validation
│   └── mcp/
│       └── index.ts          # MCP server entry point
├── .github/
│   └── workflows/
│       └── sync.yml          # GitHub Actions workflow
└── vercel.json
```

## Google Cloud Setup (OAuth)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable the Google Drive API
4. Configure OAuth consent screen:
   - User type: External
   - App name, support email, developer email
   - Scopes: `drive.readonly`
   - Test users (while in testing mode)
5. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized redirect URIs: `https://your-domain.vercel.app/api/oauth/google/callback`
6. Copy Client ID and Client Secret to environment variables
7. **Important**: Publish the app to production to avoid 7-day token expiration

## Security Considerations

- **Refresh tokens**: Encrypted at rest using AES-256-GCM
- **API keys**: Only the hash is stored; the full key is shown once at creation
- **Session tokens**: HttpOnly, Secure, SameSite cookies via Better Auth
- **CORS**: Restricted to your domain
- **Rate limiting**: Consider adding rate limiting on search endpoints

## Development

```bash
# Install dependencies
bun install

# Run database migrations
bun run migrate

# Start dev server (frontend + API)
bun run dev

# Run MCP server locally
bun run mcp
```

## Deployment

```bash
# Deploy to Vercel
vercel deploy --prod

# Set environment variables in Vercel dashboard
# Set GitHub secrets for the sync workflow
```

## Future Considerations

- Support for additional file types (PDFs, Sheets, Slides)
- Folder/drive selection (let users choose what to index)
- Webhooks for real-time sync (Google Drive push notifications)
- Usage quotas and billing for heavy users
- Team/organization accounts with shared document access
- Re-ranking with a cross-encoder for better search results
