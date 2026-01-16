# Google Drive Vector Search MCP

Vector search over Google Drive documents, exposed via an MCP server.

> **Architecture Pivot (January 2025):** This project originally used a service account approach for a single organization's Google Drive. We pivoted to a multi-tenant OAuth approach because:
> 1. Service accounts require Google Workspace admin approval, which is a blocker for many organizations
> 2. OAuth allows users to authenticate themselves without admin involvement
> 3. Multi-tenant architecture enables this to be a product anyone can use
>
> The trade-off is increased complexity (user accounts, token storage, multi-tenant data), but it's more scalable and user-friendly.

## Overview

This project enables semantic search over Google Docs for any user who connects their Google account. It consists of five components:

1. **Web App** - Next.js frontend for user authentication and Google OAuth connection (Vercel)
2. **API Server** - Next.js API routes for search, documents, and OAuth (Vercel)
3. **Sync Server** - Standalone Bun server for long-running sync jobs (Fly.io)
4. **Sync Cron** - GitHub Actions workflow that triggers syncs 3x daily
5. **MCP Server** - npm package that exposes the API to MCP clients (Claude Desktop, Cursor, etc.)

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web App       │    │  MCP Client     │    │  GitHub Actions │
│   (Next.js)     │    │  (Claude, etc)  │    │  (Cron: 3x/day) │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         │ OAuth +              │ API Key              │ CRON_SECRET
         │ Better Auth          │                      │
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Vercel API    │    │   Vercel API    │    │  Fly.io Sync    │
│  (auth, search) │    │   (search)      │    │    Server       │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
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
2. Signs up/logs in via Better Auth (Google OAuth)
3. Better Auth creates session, stores user in `users` table

### Google Drive Connection (OAuth 2.0)
1. User signs in with Google via Better Auth
2. Better Auth handles OAuth flow with `drive.readonly` scope
3. Access token + refresh token stored in `accounts` table
4. User can now sync their Google Drive

### MCP Server Authentication
1. User generates an API key from the web app dashboard
2. API key stored (hashed) in `api_keys` table
3. User configures MCP server with their API key
4. All MCP requests include the API key for user identification

## Components

### 1. Web App (Next.js on Vercel)

Next.js app with React frontend for authentication and account management.

**Pages:**
- `/` - Landing page with "Get Started" CTA
- `/login` - Better Auth login (Google OAuth)
- `/signup` - Better Auth registration
- `/dashboard` - View sync status, manage API keys, trigger sync, disconnect Google

**Tech Stack:**
- Next.js 16 (App Router)
- Better Auth
- Tailwind CSS
- TypeScript

### 2. API Server (Next.js API Routes on Vercel)

Hosted on Vercel. Handles authentication, OAuth, search, and document operations.

**Auth Endpoints (Better Auth):**

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/auth/*` | Better Auth handlers (login, signup, session, etc.) |

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

**User Endpoints (require session):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me/status` | Get user's sync status and document count |
| `POST` | `/api/me/sync` | Trigger sync for current user (calls Fly.io) |
| `DELETE` | `/api/oauth/google` | Disconnect Google Drive |

### 3. Sync Server (Bun on Fly.io)

Standalone Bun HTTP server for long-running sync operations. Deployed on Fly.io with no timeout limits.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/sync` | Sync all users (requires CRON_SECRET) |
| `POST` | `/sync/:userId` | Sync specific user (requires CRON_SECRET) |

**Features:**
- Auto-scales to zero when idle (cost: ~$0/month)
- Wakes up when pinged by GitHub Actions or dashboard
- No timeout limits - can run syncs as long as needed
- Token refresh with database persistence
- Safety safeguards against accidental data deletion

**Environment Variables:**
- `TURSO_URL` - Turso database URL
- `TURSO_AUTH_TOKEN` - Turso auth token
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `OPENAI_API_KEY` - For generating embeddings
- `CRON_SECRET` - Secret for authenticating sync requests
- `PORT` - Server port (default: 8080)

### 4. Sync Cron (GitHub Actions)

Runs 3x daily to keep all users' documents in sync.

**Schedule:** 6 AM, 2 PM, 10 PM UTC

**Process:**
1. GitHub Actions triggers at scheduled time
2. Calls Fly.io sync server `/sync` with `CRON_SECRET`
3. Sync server processes all users with connected Google accounts
4. For each user:
   - Refresh OAuth token if expired (persist new token)
   - Fetch list of all Google Docs from Drive
   - Compare against database state
   - Process new/updated/deleted documents
   - Update sync status
5. Safety checks prevent mass deletion if API returns unexpected results

**GitHub Secrets Required:**
- `SYNC_SERVER_URL` - Fly.io sync server URL (e.g., `https://brkt-gdrive-sync.fly.dev`)
- `CRON_SECRET` - Matches the sync server's `CRON_SECRET`

### 5. MCP Server (npx from GitHub)

Distributed via `npx github:tone-row/brkt-gdrive-mcp`. Thin client that calls the API with user's API key.

**Tools:**

| Tool | Description |
|------|-------------|
| `search` | Semantic search over your documents. Returns relevant chunks with source info. |
| `expand_document` | Get the full text of a document by ID. |
| `list_documents` | List all your indexed documents with metadata. |

**Configuration (Claude Desktop / Cursor):**
```json
{
  "mcpServers": {
    "gdrive-search": {
      "command": "npx",
      "args": ["-y", "github:tone-row/brkt-gdrive-mcp"],
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

### `accounts` (Better Auth - OAuth tokens)
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

*Note: `user_id` is denormalized from documents to enable filtered vector search.*

### `sync_status`
| Column | Type | Description |
|--------|------|-------------|
| `user_id` | TEXT PRIMARY KEY | FK to users.id (one row per user) |
| `status` | TEXT | 'idle', 'syncing', 'failed' |
| `started_at` | TEXT | When current/last sync started |
| `completed_at` | TEXT | When last sync completed |
| `last_result` | TEXT | JSON: {added, updated, deleted} |
| `error` | TEXT | Error message if sync failed |

*Note: This table has exactly one row per user, updated on each sync.*

## Chunking Strategy

- **Chunk size**: ~500-1000 tokens (~3000 chars)
- **Overlap**: ~100 tokens (~400 chars)
- **Method**: Split on paragraph boundaries where possible, fall back to sentence boundaries

## Embedding Model

- **Model**: OpenAI `text-embedding-3-small`
- **Dimensions**: 1536

## File Structure

```
brkt-gdrive-mcp/
├── SPEC.md                        # This file
├── README.md                      # User-facing documentation
├── package.json                   # Root package (MCP server)
├── bin/
│   └── mcp.js                     # MCP server entry point
├── www/                           # Next.js web app (Vercel)
│   ├── package.json
│   ├── next.config.ts
│   ├── src/
│   │   ├── app/                   # Next.js App Router
│   │   │   ├── page.tsx           # Landing page
│   │   │   ├── login/page.tsx
│   │   │   ├── signup/page.tsx
│   │   │   ├── dashboard/page.tsx
│   │   │   └── api/               # API routes
│   │   │       ├── auth/[...all]/route.ts
│   │   │       ├── keys/route.ts
│   │   │       ├── search/route.ts
│   │   │       ├── documents/route.ts
│   │   │       ├── me/status/route.ts
│   │   │       ├── me/sync/route.ts
│   │   │       └── oauth/google/route.ts
│   │   ├── db/
│   │   │   ├── client.ts          # Turso client
│   │   │   └── schema.ts          # Database migrations
│   │   ├── auth.ts                # Better Auth config
│   │   └── sync/                  # Sync logic (also used by Fly.io)
│   │       ├── index.ts
│   │       ├── google-drive.ts
│   │       ├── chunker.ts
│   │       └── embeddings.ts
│   └── components/                # React components
├── sync-server/                   # Fly.io sync server
│   ├── package.json
│   ├── Dockerfile
│   ├── fly.toml
│   ├── README.md
│   └── src/
│       ├── server.ts              # Bun HTTP server
│       ├── db/client.ts
│       └── sync/                  # Sync logic (copied from www)
│           ├── index.ts
│           ├── google-drive.ts
│           ├── chunker.ts
│           └── embeddings.ts
└── .github/
    └── workflows/
        └── sync.yml               # GitHub Actions cron
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
   - Authorized redirect URIs: `https://your-domain.vercel.app/api/auth/callback/google`
6. Copy Client ID and Client Secret to environment variables
7. **Important**: Publish the app to production to avoid 7-day token expiration

## Security Considerations

- **OAuth tokens**: Stored in Better Auth `accounts` table
- **Token refresh**: Handled automatically by sync server, new tokens persisted to DB
- **API keys**: Only the hash is stored; the full key is shown once at creation
- **Session tokens**: HttpOnly, Secure, SameSite cookies via Better Auth
- **Sync safety**: Multiple safeguards prevent accidental mass deletion
- **CORS**: Restricted to your domain

## Deployment

### Vercel (Web App + API)
```bash
cd www
vercel deploy --prod
```

Environment variables needed in Vercel:
- `TURSO_URL`
- `TURSO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### Fly.io (Sync Server)
```bash
cd sync-server
fly deploy
```

Secrets needed in Fly.io:
- `TURSO_URL`
- `TURSO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `CRON_SECRET`

### GitHub Actions
Secrets needed:
- `SYNC_SERVER_URL` (e.g., `https://brkt-gdrive-sync.fly.dev`)
- `CRON_SECRET`

## Future Considerations

- Support for additional file types (PDFs, Sheets, Slides)
- Folder/drive selection (let users choose what to index)
- Webhooks for real-time sync (Google Drive push notifications)
- Usage quotas and billing for heavy users
- Team/organization accounts with shared document access
- Re-ranking with a cross-encoder for better search results
