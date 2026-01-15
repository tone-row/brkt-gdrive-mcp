import { db } from "../db/client";
import { v4 as uuid } from "uuid";

/**
 * Generate a new API key
 * Returns the full key (only shown once) and the key metadata
 */
export async function generateApiKey(
  userId: string,
  name: string
): Promise<{ key: string; id: string; prefix: string; createdAt: string }> {
  // Generate a random API key: gd_<32 random chars>
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `gd_${randomPart}`;

  // Hash the key for storage
  const keyHash = await hashKey(key);
  const keyPrefix = key.slice(0, 10); // "gd_" + first 7 chars

  const id = uuid();
  const createdAt = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, userId, name, keyHash, keyPrefix, createdAt],
  });

  return { key, id, prefix: keyPrefix, createdAt };
}

/**
 * Validate an API key and return the user ID if valid
 */
export async function validateApiKey(key: string): Promise<string | null> {
  if (!key || !key.startsWith("gd_")) {
    return null;
  }

  const keyHash = await hashKey(key);

  const result = await db.execute({
    sql: `SELECT user_id, id FROM api_keys WHERE key_hash = ?`,
    args: [keyHash],
  });

  if (result.rows.length === 0) {
    return null;
  }

  // Update last_used_at
  const apiKeyId = result.rows[0]!.id as string;
  await db.execute({
    sql: `UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`,
    args: [apiKeyId],
  });

  return result.rows[0]!.user_id as string;
}

/**
 * List all API keys for a user (without the actual key values)
 */
export async function listApiKeys(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    prefix: string;
    lastUsedAt: string | null;
    createdAt: string;
  }>
> {
  const result = await db.execute({
    sql: `SELECT id, name, key_prefix, last_used_at, created_at
          FROM api_keys
          WHERE user_id = ?
          ORDER BY created_at DESC`,
    args: [userId],
  });

  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    prefix: row.key_prefix as string,
    lastUsedAt: row.last_used_at as string | null,
    createdAt: row.created_at as string,
  }));
}

/**
 * Delete an API key
 */
export async function deleteApiKey(userId: string, keyId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `DELETE FROM api_keys WHERE id = ? AND user_id = ?`,
    args: [keyId, userId],
  });

  return result.rowsAffected > 0;
}

/**
 * Hash a key using SHA-256
 */
async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
