import { db } from "../db/client";
import { runMigrations } from "../db/schema";
import { listGoogleDocs, exportDocAsText, refreshTokensIfNeeded, type DriveDocument, type GoogleTokens, type RefreshedTokens } from "./google-drive";
import { chunkText } from "./chunker";
import { generateEmbeddings } from "./embeddings";
import { markSyncStarted, markSyncCompleted, markSyncFailed } from "./status";
import { v4 as uuid } from "uuid";

// Safety threshold: if we have more than this many docs in DB but Google returns 0,
// something is likely wrong - don't delete anything
const DELETION_SAFETY_THRESHOLD = 5;

interface StoredDocument {
  id: string;
  google_doc_id: string;
  google_modified_time: string;
}

interface UserWithTokens {
  userId: string;
  email: string;
  tokens: GoogleTokens;
}

/**
 * Get all users with Google accounts connected (from Better Auth accounts table)
 */
async function getUsersWithGoogleAccounts(): Promise<UserWithTokens[]> {
  const result = await db.execute(`
    SELECT
      u.id as user_id,
      u.email,
      a.access_token,
      a.refresh_token,
      a.access_token_expires_at
    FROM users u
    JOIN accounts a ON u.id = a.user_id
    WHERE a.provider_id = 'google'
      AND a.access_token IS NOT NULL
  `);

  return result.rows.map((row) => ({
    userId: row.user_id as string,
    email: row.email as string,
    tokens: {
      accessToken: row.access_token as string,
      refreshToken: row.refresh_token as string | null,
      expiresAt: row.access_token_expires_at
        ? new Date(row.access_token_expires_at as string)
        : null,
    },
  }));
}

/**
 * Update stored tokens in the database after a refresh
 */
async function persistRefreshedTokens(userId: string, tokens: RefreshedTokens): Promise<void> {
  await db.execute({
    sql: `UPDATE accounts
          SET access_token = ?,
              refresh_token = ?,
              access_token_expires_at = ?
          WHERE user_id = ? AND provider_id = 'google'`,
    args: [
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt?.toISOString() ?? null,
      userId,
    ],
  });
  console.log("  Persisted refreshed tokens to database");
}

/**
 * Mark a user's Google account as needing re-authentication
 */
async function markAccountNeedsReauth(userId: string): Promise<void> {
  // Clear the access token so the user knows they need to re-auth
  // but keep refresh token in case it's temporarily invalid
  await db.execute({
    sql: `UPDATE accounts
          SET access_token = NULL,
              access_token_expires_at = NULL
          WHERE user_id = ? AND provider_id = 'google'`,
    args: [userId],
  });
  console.log("  Marked account as needing re-authentication");
}

/**
 * Get stored documents for a specific user
 */
async function getStoredDocuments(userId: string): Promise<Map<string, StoredDocument>> {
  const result = await db.execute({
    sql: "SELECT id, google_doc_id, google_modified_time FROM documents WHERE user_id = ?",
    args: [userId],
  });
  const docs = new Map<string, StoredDocument>();
  for (const row of result.rows) {
    docs.set(row.google_doc_id as string, {
      id: row.id as string,
      google_doc_id: row.google_doc_id as string,
      google_modified_time: row.google_modified_time as string,
    });
  }
  return docs;
}

async function indexDocument(
  userId: string,
  tokens: GoogleTokens,
  doc: DriveDocument
): Promise<void> {
  console.log(`  Indexing: ${doc.name}`);

  // Export document as plain text
  const text = await exportDocAsText(tokens, doc.id);
  if (!text || text.trim().length === 0) {
    console.log(`    Skipping empty document: ${doc.name}`);
    return;
  }

  // Chunk the text
  const chunks = chunkText(text);
  console.log(`    Created ${chunks.length} chunks`);

  // Generate embeddings for all chunks
  const chunkTexts = chunks.map((c) => c.text);
  const embeddings = await generateEmbeddings(chunkTexts);
  console.log(`    Generated ${embeddings.length} embeddings`);

  // Insert document
  const docId = uuid();
  await db.execute({
    sql: `INSERT INTO documents (id, user_id, google_doc_id, title, full_text, google_modified_time)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [docId, userId, doc.id, doc.name, text, doc.modifiedTime],
  });

  // Insert chunks with embeddings (includes user_id for efficient filtered vector search)
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = uuid();
    await db.execute({
      sql: `INSERT INTO chunks (id, document_id, user_id, chunk_index, text, embedding)
            VALUES (?, ?, ?, ?, ?, vector(?))`,
      args: [
        chunkId,
        docId,
        userId,
        chunks[i]!.index,
        chunks[i]!.text,
        `[${embeddings[i]!.join(",")}]`,
      ],
    });
  }

  console.log(`    Indexed successfully`);
}

async function updateDocument(
  userId: string,
  tokens: GoogleTokens,
  storedDoc: StoredDocument,
  driveDoc: DriveDocument
): Promise<void> {
  console.log(`  Updating: ${driveDoc.name}`);

  // Delete existing chunks
  await db.execute({
    sql: "DELETE FROM chunks WHERE document_id = ?",
    args: [storedDoc.id],
  });

  // Export document as plain text
  const text = await exportDocAsText(tokens, driveDoc.id);
  if (!text || text.trim().length === 0) {
    console.log(`    Skipping empty document: ${driveDoc.name}`);
    // Delete the document since it's now empty
    await db.execute({
      sql: "DELETE FROM documents WHERE id = ?",
      args: [storedDoc.id],
    });
    return;
  }

  // Chunk the text
  const chunks = chunkText(text);
  console.log(`    Created ${chunks.length} chunks`);

  // Generate embeddings for all chunks
  const chunkTexts = chunks.map((c) => c.text);
  const embeddings = await generateEmbeddings(chunkTexts);
  console.log(`    Generated ${embeddings.length} embeddings`);

  // Update document
  await db.execute({
    sql: `UPDATE documents
          SET title = ?, full_text = ?, google_modified_time = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [driveDoc.name, text, driveDoc.modifiedTime, storedDoc.id],
  });

  // Insert new chunks with embeddings (includes user_id)
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = uuid();
    await db.execute({
      sql: `INSERT INTO chunks (id, document_id, user_id, chunk_index, text, embedding)
            VALUES (?, ?, ?, ?, ?, vector(?))`,
      args: [
        chunkId,
        storedDoc.id,
        userId,
        chunks[i]!.index,
        chunks[i]!.text,
        `[${embeddings[i]!.join(",")}]`,
      ],
    });
  }

  console.log(`    Updated successfully`);
}

async function deleteDocument(storedDoc: StoredDocument): Promise<void> {
  console.log(`  Deleting document: ${storedDoc.google_doc_id}`);

  // Chunks will be cascade deleted
  await db.execute({
    sql: "DELETE FROM documents WHERE id = ?",
    args: [storedDoc.id],
  });

  console.log(`    Deleted successfully`);
}

/**
 * Sync a single user's Google Drive documents
 */
async function syncUser(user: UserWithTokens): Promise<{ added: number; updated: number; deleted: number; authFailed?: boolean; alreadySyncing?: boolean }> {
  console.log(`\nSyncing user: ${user.email}`);

  // Check if sync is already in progress for this user
  const canStart = await markSyncStarted(user.userId);
  if (!canStart) {
    console.log(`  Sync already in progress, skipping`);
    return { added: 0, updated: 0, deleted: 0, alreadySyncing: true };
  }

  try {
    // Step 1: Refresh tokens if needed
    const refreshedTokens = await refreshTokensIfNeeded(user.tokens);
    if (!refreshedTokens) {
      console.error(`  Authentication failed - skipping sync (documents preserved)`);
      await markAccountNeedsReauth(user.userId);
      await markSyncFailed(user.userId, "Authentication failed - please reconnect Google Drive");
      return { added: 0, updated: 0, deleted: 0, authFailed: true };
    }

    // Persist refreshed tokens if they were updated
    if (refreshedTokens.wasRefreshed) {
      await persistRefreshedTokens(user.userId, refreshedTokens);
    }

    // Use the (potentially refreshed) tokens for API calls
    const activeTokens: GoogleTokens = {
      accessToken: refreshedTokens.accessToken,
      refreshToken: refreshedTokens.refreshToken,
      expiresAt: refreshedTokens.expiresAt,
    };

    // Get current state from database for this user
    const storedDocs = await getStoredDocuments(user.userId);
    console.log(`  Found ${storedDocs.size} documents in database`);

    // Get current state from Google Drive
    let driveDocs: DriveDocument[];
    try {
      driveDocs = await listGoogleDocs(activeTokens);
    } catch (error: any) {
      console.error(`  Failed to fetch Google Drive docs: ${error.message}`);
      // CRITICAL: Do NOT delete documents when we can't reach Google
      // This preserves user data even when auth fails mid-sync
      console.log(`  Preserving ${storedDocs.size} existing documents (no deletions on API failure)`);
      await markSyncFailed(user.userId, `Failed to fetch Google Drive: ${error.message}`);
      return { added: 0, updated: 0, deleted: 0, authFailed: true };
    }
    console.log(`  Found ${driveDocs.length} documents in Google Drive`);

    // Create a set of drive doc IDs for quick lookup
    const driveDocIds = new Set(driveDocs.map((d) => d.id));

    // Find documents to delete (in database but not in drive)
    const toDelete: StoredDocument[] = [];
    for (const [googleDocId, storedDoc] of storedDocs) {
      if (!driveDocIds.has(googleDocId)) {
        toDelete.push(storedDoc);
      }
    }

    // SAFETY CHECK: If we have many docs in DB but Google returned 0 or very few,
    // something is likely wrong (API error, permissions issue, etc.)
    // Don't delete anything in this case - it's safer to have stale data than no data
    if (storedDocs.size >= DELETION_SAFETY_THRESHOLD && driveDocs.length === 0) {
      console.warn(`  ⚠️  SAFETY: Google returned 0 docs but we have ${storedDocs.size} in database`);
      console.warn(`  ⚠️  Skipping ALL deletions to prevent data loss`);
      console.warn(`  ⚠️  User may need to re-authenticate or check Google Drive permissions`);
      // Still process additions/updates but skip deletions
      toDelete.length = 0;
    } else if (toDelete.length > storedDocs.size * 0.8 && toDelete.length > DELETION_SAFETY_THRESHOLD) {
      // If we're about to delete more than 80% of docs and it's more than the threshold,
      // that's suspicious - might be an API issue
      console.warn(`  ⚠️  SAFETY: About to delete ${toDelete.length}/${storedDocs.size} docs (${Math.round(toDelete.length / storedDocs.size * 100)}%)`);
      console.warn(`  ⚠️  This seems excessive - skipping deletions as a safety measure`);
      toDelete.length = 0;
    }

    // Find documents to add or update
    const toAdd: DriveDocument[] = [];
    const toUpdate: { stored: StoredDocument; drive: DriveDocument }[] = [];

    for (const driveDoc of driveDocs) {
      const storedDoc = storedDocs.get(driveDoc.id);
      if (!storedDoc) {
        toAdd.push(driveDoc);
      } else if (driveDoc.modifiedTime > storedDoc.google_modified_time) {
        toUpdate.push({ stored: storedDoc, drive: driveDoc });
      }
    }

    console.log(`  Sync plan: +${toAdd.length} add, ~${toUpdate.length} update, -${toDelete.length} delete`);

    // Process deletions
    for (const doc of toDelete) {
      await deleteDocument(doc);
    }

    // Process additions
    for (const doc of toAdd) {
      await indexDocument(user.userId, activeTokens, doc);
    }

    // Process updates
    for (const { stored, drive } of toUpdate) {
      await updateDocument(user.userId, activeTokens, stored, drive);
    }

    const result = { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length };
    await markSyncCompleted(user.userId, result);
    return result;

  } catch (error: any) {
    console.error(`  Sync failed with error: ${error.message}`);
    await markSyncFailed(user.userId, error.message);
    throw error;
  }
}

/**
 * Sync all users' Google Drive documents
 */
async function sync(): Promise<void> {
  console.log("Starting multi-tenant sync...");
  console.log(`Time: ${new Date().toISOString()}`);

  // Ensure migrations are run
  await runMigrations();

  // Get all users with Google accounts
  const users = await getUsersWithGoogleAccounts();
  console.log(`Found ${users.length} users with Google accounts`);

  if (users.length === 0) {
    console.log("No users to sync");
    return;
  }

  let totalAdded = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;

  // Sync each user
  for (const user of users) {
    try {
      const result = await syncUser(user);
      totalAdded += result.added;
      totalUpdated += result.updated;
      totalDeleted += result.deleted;
    } catch (error: any) {
      console.error(`Failed to sync user ${user.email}: ${error.message}`);
    }
  }

  console.log("\n========================================");
  console.log("Sync completed successfully!");
  console.log(`Total: +${totalAdded} added, ~${totalUpdated} updated, -${totalDeleted} deleted`);
  console.log("========================================");
}

/**
 * Sync a specific user by ID (for on-demand sync from dashboard)
 */
export async function syncUserById(userId: string): Promise<{ added: number; updated: number; deleted: number }> {
  const result = await db.execute({
    sql: `
      SELECT
        u.id as user_id,
        u.email,
        a.access_token,
        a.refresh_token,
        a.access_token_expires_at
      FROM users u
      JOIN accounts a ON u.id = a.user_id
      WHERE u.id = ? AND a.provider_id = 'google'
    `,
    args: [userId],
  });

  if (result.rows.length === 0) {
    throw new Error("User not found or Google account not connected");
  }

  const row = result.rows[0]!;

  // Check if account needs re-authentication
  if (!row.access_token) {
    throw new Error("Google account needs re-authentication. Please disconnect and reconnect your Google account.");
  }

  const user: UserWithTokens = {
    userId: row.user_id as string,
    email: row.email as string,
    tokens: {
      accessToken: row.access_token as string,
      refreshToken: row.refresh_token as string | null,
      expiresAt: row.access_token_expires_at
        ? new Date(row.access_token_expires_at as string)
        : null,
    },
  };

  return syncUser(user);
}

// Run sync if this file is executed directly
if (import.meta.main) {
  sync()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Sync failed:", err);
      process.exit(1);
    });
}

export { sync };
