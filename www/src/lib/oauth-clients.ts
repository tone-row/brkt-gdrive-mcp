import { db } from "../db/client";
import { v4 as uuid } from "uuid";

/**
 * Hash a string using SHA-256 (returns hex string)
 */
async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash a string using SHA-256 and return base64url encoded result
 * Used for PKCE S256 code challenge verification
 */
async function hashToBase64Url(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  // Convert to base64url
  let binary = "";
  for (let i = 0; i < hashArray.length; i++) {
    binary += String.fromCharCode(hashArray[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate a random secret
 */
function generateSecret(length: number = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// OAuth Client Management
// ============================================================

export interface OAuthClient {
  id: string;
  userId: string;
  name: string;
  clientId: string;
  clientIdPrefix: string;
  createdAt: string;
}

/**
 * Create a new OAuth client for a user
 * Returns the full client secret (only shown once)
 */
export async function createOAuthClient(
  userId: string,
  name: string
): Promise<{ client: OAuthClient; clientSecret: string }> {
  const id = uuid();
  const clientId = `mcp_${generateSecret(16)}`;
  const clientSecret = generateSecret(32);
  const clientSecretHash = await hashString(clientSecret);
  const clientIdPrefix = clientId.slice(0, 12);
  const createdAt = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO oauth_clients (id, user_id, name, client_id, client_secret_hash, client_id_prefix, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, userId, name, clientId, clientSecretHash, clientIdPrefix, createdAt],
  });

  return {
    client: {
      id,
      userId,
      name,
      clientId,
      clientIdPrefix,
      createdAt,
    },
    clientSecret,
  };
}

/**
 * List all OAuth clients for a user
 */
export async function listOAuthClients(userId: string): Promise<OAuthClient[]> {
  const result = await db.execute({
    sql: `SELECT id, user_id, name, client_id, client_id_prefix, created_at
          FROM oauth_clients
          WHERE user_id = ?
          ORDER BY created_at DESC`,
    args: [userId],
  });

  return result.rows.map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    clientId: row.client_id as string,
    clientIdPrefix: row.client_id_prefix as string,
    createdAt: row.created_at as string,
  }));
}

/**
 * Delete an OAuth client
 */
export async function deleteOAuthClient(userId: string, clientDbId: string): Promise<boolean> {
  // Also delete any associated tokens and codes
  const client = await db.execute({
    sql: `SELECT client_id FROM oauth_clients WHERE id = ? AND user_id = ?`,
    args: [clientDbId, userId],
  });

  if (client.rows.length === 0) return false;

  const clientId = client.rows[0]!.client_id as string;

  // Delete tokens and codes first
  await db.execute({
    sql: `DELETE FROM oauth_access_tokens WHERE client_id = ?`,
    args: [clientId],
  });
  await db.execute({
    sql: `DELETE FROM oauth_authorization_codes WHERE client_id = ?`,
    args: [clientId],
  });

  // Delete the client
  const result = await db.execute({
    sql: `DELETE FROM oauth_clients WHERE id = ? AND user_id = ?`,
    args: [clientDbId, userId],
  });

  return result.rowsAffected > 0;
}

/**
 * Validate client credentials and return user ID if valid
 */
export async function validateClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<{ userId: string; clientId: string } | null> {
  const secretHash = await hashString(clientSecret);

  const result = await db.execute({
    sql: `SELECT user_id, client_id FROM oauth_clients WHERE client_id = ? AND client_secret_hash = ?`,
    args: [clientId, secretHash],
  });

  if (result.rows.length === 0) return null;

  return {
    userId: result.rows[0]!.user_id as string,
    clientId: result.rows[0]!.client_id as string,
  };
}

/**
 * Get OAuth client by client_id
 */
export async function getOAuthClientByClientId(clientId: string): Promise<OAuthClient | null> {
  const result = await db.execute({
    sql: `SELECT id, user_id, name, client_id, client_id_prefix, created_at
          FROM oauth_clients
          WHERE client_id = ?`,
    args: [clientId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    clientId: row.client_id as string,
    clientIdPrefix: row.client_id_prefix as string,
    createdAt: row.created_at as string,
  };
}

// ============================================================
// Authorization Codes
// ============================================================

/**
 * Create an authorization code
 */
export async function createAuthorizationCode(
  clientId: string,
  userId: string,
  redirectUri: string,
  scope: string,
  codeChallenge?: string,
  codeChallengeMethod?: string
): Promise<string> {
  const code = generateSecret(32);
  const codeHash = await hashString(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  await db.execute({
    sql: `INSERT INTO oauth_authorization_codes
          (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [codeHash, clientId, userId, redirectUri, scope, codeChallenge || null, codeChallengeMethod || null, expiresAt],
  });

  return code;
}

/**
 * Exchange an authorization code for tokens
 * Returns the user ID if valid, null otherwise
 */
export async function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<{ userId: string; scope: string } | null> {
  const codeHash = await hashString(code);

  const result = await db.execute({
    sql: `SELECT user_id, scope, redirect_uri, code_challenge, code_challenge_method, expires_at
          FROM oauth_authorization_codes
          WHERE code_hash = ? AND client_id = ?`,
    args: [codeHash, clientId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;

  // Check expiration
  if (new Date(row.expires_at as string) < new Date()) {
    // Delete expired code
    await db.execute({
      sql: `DELETE FROM oauth_authorization_codes WHERE code_hash = ?`,
      args: [codeHash],
    });
    return null;
  }

  // Check redirect URI
  if (row.redirect_uri !== redirectUri) return null;

  // Check PKCE if code challenge was provided
  if (row.code_challenge) {
    if (!codeVerifier) return null;

    if (row.code_challenge_method === "S256") {
      // S256: code_challenge = BASE64URL(SHA256(code_verifier))
      const expectedChallenge = await hashToBase64Url(codeVerifier);
      if (expectedChallenge !== row.code_challenge) return null;
    } else if (row.code_challenge_method === "plain") {
      if (codeVerifier !== row.code_challenge) return null;
    }
  }

  // Delete the code (one-time use)
  await db.execute({
    sql: `DELETE FROM oauth_authorization_codes WHERE code_hash = ?`,
    args: [codeHash],
  });

  return {
    userId: row.user_id as string,
    scope: row.scope as string,
  };
}

// ============================================================
// Access Tokens
// ============================================================

/**
 * Create access and refresh tokens
 */
export async function createTokens(
  clientId: string,
  userId: string,
  scope: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = `at_${generateSecret(32)}`;
  const refreshToken = `rt_${generateSecret(32)}`;
  const accessTokenHash = await hashString(accessToken);
  const refreshTokenHash = await hashString(refreshToken);
  const expiresIn = 3600; // 1 hour
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  await db.execute({
    sql: `INSERT INTO oauth_access_tokens
          (access_token_hash, refresh_token_hash, client_id, user_id, scope, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [accessTokenHash, refreshTokenHash, clientId, userId, scope, expiresAt],
  });

  return { accessToken, refreshToken, expiresIn };
}

/**
 * Validate an access token and return the user ID if valid
 */
export async function validateAccessToken(accessToken: string): Promise<string | null> {
  if (!accessToken.startsWith("at_")) return null;

  const tokenHash = await hashString(accessToken);

  const result = await db.execute({
    sql: `SELECT user_id, expires_at FROM oauth_access_tokens WHERE access_token_hash = ?`,
    args: [tokenHash],
  });

  if (result.rows.length === 0) return null;

  // Check expiration
  if (new Date(result.rows[0]!.expires_at as string) < new Date()) {
    return null;
  }

  return result.rows[0]!.user_id as string;
}

/**
 * Refresh tokens using a refresh token
 */
export async function refreshTokens(
  refreshToken: string,
  clientId: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  if (!refreshToken.startsWith("rt_")) return null;

  const tokenHash = await hashString(refreshToken);

  const result = await db.execute({
    sql: `SELECT user_id, scope FROM oauth_access_tokens
          WHERE refresh_token_hash = ? AND client_id = ?`,
    args: [tokenHash, clientId],
  });

  if (result.rows.length === 0) return null;

  const userId = result.rows[0]!.user_id as string;
  const scope = result.rows[0]!.scope as string;

  // Delete the old token
  await db.execute({
    sql: `DELETE FROM oauth_access_tokens WHERE refresh_token_hash = ?`,
    args: [tokenHash],
  });

  // Create new tokens
  return createTokens(clientId, userId, scope);
}

/**
 * Revoke all tokens for a client
 */
export async function revokeTokensForClient(clientId: string): Promise<void> {
  await db.execute({
    sql: `DELETE FROM oauth_access_tokens WHERE client_id = ?`,
    args: [clientId],
  });
}
