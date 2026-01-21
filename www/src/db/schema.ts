import { db } from "./client";

export async function runMigrations() {
  // ========================================
  // Better Auth tables
  // ========================================

  // Users table (Better Auth)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      email_verified INTEGER DEFAULT 0,
      name TEXT,
      image TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Sessions table (Better Auth)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Accounts table (Better Auth - for social logins)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      access_token_expires_at TEXT,
      scope TEXT,
      id_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Verification tokens table (Better Auth)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ========================================
  // Application tables
  // ========================================

  // API keys for MCP server authentication
  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Google Drive connections (OAuth tokens)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS google_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      google_email TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      scopes TEXT NOT NULL,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_sync_at TEXT,
      sync_status TEXT NOT NULL DEFAULT 'active',
      sync_error TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Documents table (multi-tenant: includes user_id)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      google_doc_id TEXT NOT NULL,
      title TEXT NOT NULL,
      full_text TEXT NOT NULL,
      google_modified_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, google_doc_id)
    )
  `);

  // Chunks table with vector embedding
  // user_id is denormalized from documents for efficient filtered vector search
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding F32_BLOB(1536),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create vector index for similarity search
  await db.execute(`
    CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks(libsql_vector_idx(embedding))
  `);

  // Create index on document_id for faster lookups
  await db.execute(`
    CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks(document_id)
  `);

  // Create index on user_id for filtered vector search
  await db.execute(`
    CREATE INDEX IF NOT EXISTS chunks_user_id_idx ON chunks(user_id)
  `);

  // Create index on user_id for documents
  await db.execute(`
    CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents(user_id)
  `);

  // ========================================
  // Sync status tracking (one row per user)
  // ========================================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_status (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT,
      completed_at TEXT,
      last_result TEXT,
      error TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // ========================================
  // OAuth 2.0 tables for MCP remote authentication
  // ========================================

  // OAuth clients (client_id + client_secret pairs)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      client_id TEXT UNIQUE NOT NULL,
      client_secret_hash TEXT NOT NULL,
      client_id_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Authorization codes (short-lived, one-time use)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Access tokens (short-lived) and refresh tokens (long-lived)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      access_token_hash TEXT PRIMARY KEY,
      refresh_token_hash TEXT UNIQUE NOT NULL,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create index on client_id for oauth_clients
  await db.execute(`
    CREATE INDEX IF NOT EXISTS oauth_clients_user_id_idx ON oauth_clients(user_id)
  `);

  console.log("Migrations completed successfully");
}

// Run migrations if this file is executed directly
if (import.meta.main) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
