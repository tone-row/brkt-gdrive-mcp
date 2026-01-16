# Google Drive Sync Server

Standalone sync server for indexing Google Drive documents. Designed to run on Fly.io with no timeout limits.

## Environment Variables

Required:
- `TURSO_URL` - Turso database URL
- `TURSO_AUTH_TOKEN` - Turso auth token
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `OPENAI_API_KEY` - OpenAI API key for embeddings
- `CRON_SECRET` - Secret for authenticating sync requests

Optional:
- `PORT` - Server port (default: 8080)

## Local Development

```bash
# Install dependencies
bun install

# Run server (requires env vars)
bun run dev
```

## Deployment to Fly.io

### First-time setup

1. Install the Fly CLI: https://fly.io/docs/hands-on/install-flyctl/

2. Login to Fly:
   ```bash
   fly auth login
   ```

3. Create the app:
   ```bash
   cd sync-server
   fly apps create brkt-gdrive-sync
   ```

4. Set secrets:
   ```bash
   fly secrets set \
     TURSO_URL="libsql://your-db.turso.io" \
     TURSO_AUTH_TOKEN="your-token" \
     GOOGLE_CLIENT_ID="your-client-id" \
     GOOGLE_CLIENT_SECRET="your-client-secret" \
     OPENAI_API_KEY="your-openai-key" \
     CRON_SECRET="your-cron-secret"
   ```

5. Deploy:
   ```bash
   fly deploy
   ```

### Subsequent deployments

```bash
cd sync-server
fly deploy
```

## Endpoints

- `GET /` or `GET /health` - Health check
- `POST /sync` - Trigger sync (requires `Authorization: Bearer <CRON_SECRET>`)

## GitHub Actions Setup

After deploying, add the `SYNC_SERVER_URL` secret to your GitHub repo:

```
SYNC_SERVER_URL=https://brkt-gdrive-sync.fly.dev
```

The existing `CRON_SECRET` should match what you set in Fly.io secrets.
