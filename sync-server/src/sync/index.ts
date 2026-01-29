import { db } from "../db/client";
import { listGoogleDocs, exportDocAsText, refreshTokensIfNeeded, type DriveDocument, type GoogleTokens, type RefreshedTokens } from "./google-drive";
import { chunkText } from "./chunker";
import { generateEmbeddings } from "./embeddings";
import {
  markSyncStarted,
  markSyncCompleted,
  markSyncFailed,
  setV2Processing,
  updateV2Progress,
  createFileJobs,
  markFileProcessing,
  markFileCompleted,
  markFileFailed,
} from "./status";
import { v4 as uuid } from "uuid";
import { v2TablesExist, writeDocumentToV2, updateDocumentInV2, removeUserAccessFromV2 } from "./dual-write";

// Flag to enable/disable dual-write to V2 tables
// Set to true after running Phase 1 and Phase 2 migrations
let dualWriteEnabled: boolean | null = null;

async function isDualWriteEnabled(): Promise<boolean> {
  if (dualWriteEnabled === null) {
    dualWriteEnabled = await v2TablesExist();
    if (dualWriteEnabled) {
      console.log("[Dual-Write] V2 tables detected, dual-write enabled");
    }
  }
  return dualWriteEnabled;
}

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
 * Get a specific user with their tokens
 */
async function getUserById(userId: string): Promise<UserWithTokens | null> {
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
    return null;
  }

  const row = result.rows[0]!;

  if (!row.access_token) {
    return null; // User needs to re-authenticate
  }

  return {
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

  const text = await exportDocAsText(tokens, doc.id);
  if (!text || text.trim().length === 0) {
    console.log(`    Skipping empty document: ${doc.name}`);
    return;
  }

  const chunks = chunkText(text);
  console.log(`    Created ${chunks.length} chunks`);

  const docId = uuid();

  // Insert document with a placeholder timestamp - we'll update it AFTER all chunks succeed.
  // This ensures that if we die mid-chunks, the next sync will see this doc needs re-indexing.
  const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";
  await db.execute({
    sql: `INSERT INTO documents (id, user_id, google_doc_id, title, full_text, google_modified_time)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [docId, userId, doc.id, doc.name, text, PLACEHOLDER_TIME],
  });

  // Collect all chunks with embeddings for dual-write
  const allChunksWithEmbeddings: Array<{ index: number; text: string; embedding: number[] }> = [];

  // Process chunks in small batches to reduce memory usage
  const CHUNK_BATCH_SIZE = 10;
  for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + CHUNK_BATCH_SIZE);
    const batchTexts = batchChunks.map((c) => c.text);
    const batchEmbeddings = await generateEmbeddings(batchTexts);

    for (let j = 0; j < batchChunks.length; j++) {
      const chunkId = uuid();
      await db.execute({
        sql: `INSERT INTO chunks (id, document_id, user_id, chunk_index, text, embedding)
              VALUES (?, ?, ?, ?, ?, vector(?))`,
        args: [
          chunkId,
          docId,
          userId,
          batchChunks[j]!.index,
          batchChunks[j]!.text,
          `[${batchEmbeddings[j]!.join(",")}]`,
        ],
      });

      // Collect for dual-write
      allChunksWithEmbeddings.push({
        index: batchChunks[j]!.index,
        text: batchChunks[j]!.text,
        embedding: batchEmbeddings[j]!,
      });
    }
  }

  // NOW update the timestamp - all chunks succeeded
  await db.execute({
    sql: `UPDATE documents SET google_modified_time = ? WHERE id = ?`,
    args: [doc.modifiedTime, docId],
  });

  console.log(`    Indexed ${chunks.length} chunks successfully`);

  // Dual-write to V2 tables (non-blocking, errors are logged but don't fail sync)
  if (await isDualWriteEnabled()) {
    await writeDocumentToV2(userId, doc.id, doc.name, text, doc.modifiedTime, allChunksWithEmbeddings);
  }
}

async function updateDocument(
  userId: string,
  tokens: GoogleTokens,
  storedDoc: StoredDocument,
  driveDoc: DriveDocument
): Promise<void> {
  console.log(`  Updating: ${driveDoc.name}`);

  // Delete old chunks first
  await db.execute({
    sql: "DELETE FROM chunks WHERE document_id = ?",
    args: [storedDoc.id],
  });

  const text = await exportDocAsText(tokens, driveDoc.id);
  if (!text || text.trim().length === 0) {
    console.log(`    Skipping empty document: ${driveDoc.name}`);
    await db.execute({
      sql: "DELETE FROM documents WHERE id = ?",
      args: [storedDoc.id],
    });
    // Also remove from V2 if dual-write is enabled
    if (await isDualWriteEnabled()) {
      await removeUserAccessFromV2(userId, driveDoc.id);
    }
    return;
  }

  const chunks = chunkText(text);
  console.log(`    Created ${chunks.length} chunks`);

  // Update document content but NOT the timestamp yet.
  // We'll update timestamp AFTER all chunks succeed.
  // This ensures if we die mid-chunks, next sync will re-index this doc.
  await db.execute({
    sql: `UPDATE documents
          SET title = ?, full_text = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [driveDoc.name, text, storedDoc.id],
  });

  // Collect all chunks with embeddings for dual-write
  const allChunksWithEmbeddings: Array<{ index: number; text: string; embedding: number[] }> = [];

  // Process chunks in small batches to reduce memory usage
  const CHUNK_BATCH_SIZE = 10;
  for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + CHUNK_BATCH_SIZE);
    const batchTexts = batchChunks.map((c) => c.text);
    const batchEmbeddings = await generateEmbeddings(batchTexts);

    for (let j = 0; j < batchChunks.length; j++) {
      const chunkId = uuid();
      await db.execute({
        sql: `INSERT INTO chunks (id, document_id, user_id, chunk_index, text, embedding)
              VALUES (?, ?, ?, ?, ?, vector(?))`,
        args: [
          chunkId,
          storedDoc.id,
          userId,
          batchChunks[j]!.index,
          batchChunks[j]!.text,
          `[${batchEmbeddings[j]!.join(",")}]`,
        ],
      });

      // Collect for dual-write
      allChunksWithEmbeddings.push({
        index: batchChunks[j]!.index,
        text: batchChunks[j]!.text,
        embedding: batchEmbeddings[j]!,
      });
    }
  }

  // NOW update the timestamp - all chunks succeeded
  await db.execute({
    sql: `UPDATE documents SET google_modified_time = ? WHERE id = ?`,
    args: [driveDoc.modifiedTime, storedDoc.id],
  });

  console.log(`    Updated ${chunks.length} chunks successfully`);

  // Dual-write to V2 tables (non-blocking, errors are logged but don't fail sync)
  if (await isDualWriteEnabled()) {
    await updateDocumentInV2(userId, driveDoc.id, driveDoc.name, text, driveDoc.modifiedTime, allChunksWithEmbeddings);
  }
}

async function deleteDocument(storedDoc: StoredDocument, userId: string): Promise<void> {
  console.log(`  Deleting document: ${storedDoc.google_doc_id}`);

  await db.execute({
    sql: "DELETE FROM documents WHERE id = ?",
    args: [storedDoc.id],
  });

  console.log(`    Deleted successfully`);

  // Also remove from V2 if dual-write is enabled
  if (await isDualWriteEnabled()) {
    await removeUserAccessFromV2(userId, storedDoc.google_doc_id);
  }
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
    const refreshedTokens = await refreshTokensIfNeeded(user.tokens);
    if (!refreshedTokens) {
      console.error(`  Authentication failed - skipping sync (documents preserved)`);
      await markAccountNeedsReauth(user.userId);
      await markSyncFailed(user.userId, "Authentication failed - please reconnect Google Drive");
      return { added: 0, updated: 0, deleted: 0, authFailed: true };
    }

    if (refreshedTokens.wasRefreshed) {
      await persistRefreshedTokens(user.userId, refreshedTokens);
    }

    const activeTokens: GoogleTokens = {
      accessToken: refreshedTokens.accessToken,
      refreshToken: refreshedTokens.refreshToken,
      expiresAt: refreshedTokens.expiresAt,
    };

    const storedDocs = await getStoredDocuments(user.userId);
    console.log(`  Found ${storedDocs.size} documents in database`);

    let driveDocs: DriveDocument[];
    try {
      driveDocs = await listGoogleDocs(activeTokens);
    } catch (error: any) {
      console.error(`  Failed to fetch Google Drive docs: ${error.message}`);
      console.log(`  Preserving ${storedDocs.size} existing documents (no deletions on API failure)`);

      // Check if this is an auth error and mark account for re-auth
      const isAuthError = error.message?.includes("Invalid Credentials") ||
                          error.message?.includes("Unauthorized") ||
                          error.message?.includes("invalid_grant") ||
                          error.status === 401;
      if (isAuthError) {
        await markAccountNeedsReauth(user.userId);
        await markSyncFailed(user.userId, "Authentication failed - please reconnect Google Drive");
      } else {
        await markSyncFailed(user.userId, `Failed to fetch Google Drive: ${error.message}`);
      }
      return { added: 0, updated: 0, deleted: 0, authFailed: true };
    }
    console.log(`  Found ${driveDocs.length} documents in Google Drive`);

    const driveDocIds = new Set(driveDocs.map((d) => d.id));

    const toDelete: StoredDocument[] = [];
    for (const [googleDocId, storedDoc] of storedDocs) {
      if (!driveDocIds.has(googleDocId)) {
        toDelete.push(storedDoc);
      }
    }

    // Safety checks
    if (storedDocs.size >= DELETION_SAFETY_THRESHOLD && driveDocs.length === 0) {
      console.warn(`  ⚠️  SAFETY: Google returned 0 docs but we have ${storedDocs.size} in database`);
      console.warn(`  ⚠️  Skipping ALL deletions to prevent data loss`);
      toDelete.length = 0;
    } else if (toDelete.length > storedDocs.size * 0.8 && toDelete.length > DELETION_SAFETY_THRESHOLD) {
      console.warn(`  ⚠️  SAFETY: About to delete ${toDelete.length}/${storedDocs.size} docs`);
      console.warn(`  ⚠️  This seems excessive - skipping deletions as a safety measure`);
      toDelete.length = 0;
    }

    const toAdd: DriveDocument[] = [];
    const toUpdate: { stored: StoredDocument; drive: DriveDocument }[] = [];

    // Placeholder timestamp used for incomplete indexing
    const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";

    for (const driveDoc of driveDocs) {
      const storedDoc = storedDocs.get(driveDoc.id);
      if (!storedDoc) {
        toAdd.push(driveDoc);
      } else if (
        driveDoc.modifiedTime > storedDoc.google_modified_time ||
        storedDoc.google_modified_time === PLACEHOLDER_TIME
      ) {
        // Re-index if: Google has newer version OR doc was partially indexed (has placeholder timestamp)
        toUpdate.push({ stored: storedDoc, drive: driveDoc });
      }
    }

    console.log(`  Sync plan: +${toAdd.length} add, ~${toUpdate.length} update, -${toDelete.length} delete`);

    // Create file jobs for progress tracking
    const allFilesToProcess = [
      ...toAdd.map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType, modifiedTime: d.modifiedTime })),
      ...toUpdate.map(({ drive: d }) => ({ id: d.id, name: d.name, mimeType: d.mimeType, modifiedTime: d.modifiedTime })),
    ];
    await createFileJobs(user.userId, allFilesToProcess);
    await setV2Processing(user.userId, allFilesToProcess.length);

    let filesProcessed = 0;
    let filesFailed = 0;

    for (const doc of toDelete) {
      await deleteDocument(doc, user.userId);
    }

    for (const doc of toAdd) {
      try {
        await markFileProcessing(user.userId, doc.id);
        await indexDocument(user.userId, activeTokens, doc);
        await markFileCompleted(user.userId, doc.id);
        filesProcessed++;
      } catch (e: any) {
        await markFileFailed(user.userId, doc.id, e.message || "Unknown error");
        filesFailed++;
        console.error(`    Failed to index ${doc.name}: ${e.message}`);
      }
      await updateV2Progress(user.userId, filesProcessed, filesFailed);
    }

    for (const { stored, drive } of toUpdate) {
      try {
        await markFileProcessing(user.userId, drive.id);
        await updateDocument(user.userId, activeTokens, stored, drive);
        await markFileCompleted(user.userId, drive.id);
        filesProcessed++;
      } catch (e: any) {
        await markFileFailed(user.userId, drive.id, e.message || "Unknown error");
        filesFailed++;
        console.error(`    Failed to update ${drive.name}: ${e.message}`);
      }
      await updateV2Progress(user.userId, filesProcessed, filesFailed);
    }

    const result = { added: toAdd.length - filesFailed, updated: toUpdate.length, deleted: toDelete.length };
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
export async function sync(): Promise<{
  totalAdded: number;
  totalUpdated: number;
  totalDeleted: number;
  usersProcessed: number;
  authFailures: number;
}> {
  console.log("Starting multi-tenant sync...");
  console.log(`Time: ${new Date().toISOString()}`);

  const users = await getUsersWithGoogleAccounts();
  console.log(`Found ${users.length} users with Google accounts`);

  if (users.length === 0) {
    console.log("No users to sync");
    return { totalAdded: 0, totalUpdated: 0, totalDeleted: 0, usersProcessed: 0, authFailures: 0 };
  }

  let totalAdded = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let authFailures = 0;

  for (const user of users) {
    try {
      const result = await syncUser(user);
      totalAdded += result.added;
      totalUpdated += result.updated;
      totalDeleted += result.deleted;
      if (result.authFailed) {
        authFailures++;
      }
    } catch (error: any) {
      console.error(`Failed to sync user ${user.email}: ${error.message}`);
    }
  }

  console.log("\n========================================");
  console.log("Sync completed!");
  console.log(`Total: +${totalAdded} added, ~${totalUpdated} updated, -${totalDeleted} deleted`);
  console.log(`Users processed: ${users.length}, Auth failures: ${authFailures}`);
  console.log("========================================");

  return {
    totalAdded,
    totalUpdated,
    totalDeleted,
    usersProcessed: users.length,
    authFailures,
  };
}

/**
 * Sync a specific user by ID
 */
export async function syncUserById(userId: string): Promise<{
  added: number;
  updated: number;
  deleted: number;
  authFailed?: boolean;
  alreadySyncing?: boolean;
}> {
  console.log(`Starting sync for user: ${userId}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const user = await getUserById(userId);
  if (!user) {
    throw new Error("User not found or Google account needs re-authentication");
  }

  return syncUser(user);
}
