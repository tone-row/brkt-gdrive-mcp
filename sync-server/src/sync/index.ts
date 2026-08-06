import { db } from "../db/client";
import { listSupportedFiles, exportDocAsText, exportSheetAsXlsx, downloadFile, refreshTokensIfNeeded, type DriveDocument, type GoogleTokens, type RefreshedTokens } from "./google-drive";
import { extractTextFromPdf, extractTextFromDocx, extractTextFromDoc, extractTextFromSpreadsheet } from "./extractors";
import { makeDeadline } from "./chunk-store";
import {
  markSyncStarted,
  markSyncCompleted,
  markSyncFailed,
  setV2Processing,
  updateV2Progress,
  updateV2Heartbeat,
  createFileJobs,
  markFileProcessing,
  markFileCompleted,
  markFileFailed,
  markFileSkipped,
} from "./status";
import {
  PLACEHOLDER_TIME,
  resolveDocV2,
  upsertUserAccess,
  removeUserAccess,
  writeDocumentV2,
} from "./v2-store";

// Maximum file size for processing (10 MB)
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Google-native files have no size metadata, so the cap above never applies
// to them. Sheets are the dangerous case: the XLSX export is zipped XML that
// the parser inflates ~50-100x in memory — a single large sheet OOM-killed
// the 1GB worker. Cap the exported size instead.
const MAX_SHEET_EXPORT_BYTES = 5 * 1024 * 1024;

// Cap on EXTRACTED text, format-agnostic. Text length is what actually drives
// cost (chunks, embeddings, per-user DB amplification): 2 MB of text is
// ~700 chunks per user copy. File-byte caps above are just the cheap first
// gate; this is the real one.
const MAX_EXTRACTED_TEXT_CHARS = 2 * 1024 * 1024;

function oversizeReason(text: string): string | null {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return null;
  const mb = (text.length / 1024 / 1024).toFixed(1);
  return `Document exceeds the ingestion size limit (${mb} MB of text, max 2 MB)`;
}

// Per-file time budget. Incremental writes mean hitting it loses no work.
const FILE_DEADLINE_MS = 10 * 60 * 1000;

// Result type for text extraction
type ExtractResult =
  | { success: true; text: string }
  | { success: false; skip: true; reason: string }
  | { success: false; skip: false; error: string };

/**
 * Extract text from a file based on its MIME type
 */
async function extractText(tokens: GoogleTokens, file: DriveDocument): Promise<ExtractResult> {
  // Skip files over 10 MB (Google Docs don't have size, always process them)
  if (file.size && file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    return { success: false, skip: true, reason: `File too large (${sizeMb} MB, max 10 MB)` };
  }

  switch (file.mimeType) {
    case "application/vnd.google-apps.document":
      return { success: true, text: await exportDocAsText(tokens, file.id) };

    case "application/pdf": {
      const pdfBuffer = await downloadFile(tokens, file.id);
      const pdfText = await extractTextFromPdf(pdfBuffer);
      if (!pdfText.trim()) {
        return { success: false, skip: true, reason: "PDF has no extractable text (may be scanned)" };
      }
      return { success: true, text: pdfText };
    }

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const docxBuffer = await downloadFile(tokens, file.id);
      const docxText = await extractTextFromDocx(docxBuffer);
      return { success: true, text: docxText };
    }

    case "application/msword": {
      const docBuffer = await downloadFile(tokens, file.id);
      const docText = await extractTextFromDoc(docBuffer);
      return { success: true, text: docText };
    }

    case "application/vnd.google-apps.spreadsheet": {
      const xlsxBuffer = await exportSheetAsXlsx(tokens, file.id);
      if (xlsxBuffer.length > MAX_SHEET_EXPORT_BYTES) {
        const sizeMb = (xlsxBuffer.length / 1024 / 1024).toFixed(1);
        return { success: false, skip: true, reason: `Spreadsheet export too large (${sizeMb} MB, max 5 MB)` };
      }
      const sheetText = extractTextFromSpreadsheet(xlsxBuffer);
      if (!sheetText.trim()) {
        return { success: false, skip: true, reason: "Spreadsheet is empty" };
      }
      return { success: true, text: sheetText };
    }

    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.ms-excel": {
      const spreadsheetBuffer = await downloadFile(tokens, file.id);
      const spreadsheetText = extractTextFromSpreadsheet(spreadsheetBuffer);
      if (!spreadsheetText.trim()) {
        return { success: false, skip: true, reason: "Spreadsheet is empty" };
      }
      return { success: true, text: spreadsheetText };
    }

    default:
      return { success: false, skip: false, error: `Unsupported file type: ${file.mimeType}` };
  }
}

// Self-healing migration: the incremental chunk diff needs a content_hash
// column. Additive only — existing rows get hashes backfilled lazily from
// their stored text the first time their document is updated.
let contentHashEnsured = false;
async function ensureContentHashColumns(): Promise<void> {
  if (contentHashEnsured) return;
  try {
    await db.execute(`ALTER TABLE document_vectors ADD COLUMN content_hash TEXT`);
    console.log(`[Schema] Added content_hash column to document_vectors`);
  } catch (error: any) {
    if (!/duplicate column/i.test(error.message || "")) {
      throw error;
    }
  }
  contentHashEnsured = true;
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
 * Get the documents a user has access to (their view of the shared V2 corpus)
 */
async function getStoredDocuments(userId: string): Promise<Map<string, StoredDocument>> {
  const result = await db.execute({
    sql: `SELECT d.id, d.google_doc_id, d.google_modified_time
          FROM documents_v2 d
          JOIN user_document_access uda ON uda.document_id = d.id
          WHERE uda.user_id = ?`,
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
): Promise<{ indexed: boolean; skipped?: boolean; skipReason?: string }> {
  console.log(`  Indexing: ${doc.name}`);
  const deadline = makeDeadline(FILE_DEADLINE_MS);

  // Shared-doc fast path: another user already indexed this exact (or newer)
  // version — just grant access, no download or embedding needed.
  const existing = await resolveDocV2(doc.id);
  if (existing && existing.modifiedTime !== PLACEHOLDER_TIME && existing.modifiedTime >= doc.modifiedTime) {
    await upsertUserAccess(userId, existing.id);
    console.log(`    Already indexed (shared) — granted access`);
    return { indexed: true };
  }

  const result = await extractText(tokens, doc);
  if (!result.success) {
    if (result.skip) {
      console.log(`    Skipping: ${result.reason}`);
      return { indexed: false, skipped: true, skipReason: result.reason };
    }
    throw new Error(result.error);
  }

  const text = result.text;
  if (!text || text.trim().length === 0) {
    console.log(`    Skipping empty document: ${doc.name}`);
    return { indexed: false, skipped: true, skipReason: "Document is empty" };
  }

  const oversize = oversizeReason(text);
  if (oversize) {
    console.log(`    Skipping: ${oversize}`);
    return { indexed: false, skipped: true, skipReason: oversize };
  }

  const written = await writeDocumentV2(userId, doc.id, doc.name, text, doc.modifiedTime, deadline);
  console.log(`    Indexed (${written.embedded} embedded, ${written.reused} reused)`);
  return { indexed: true };
}

async function updateDocument(
  userId: string,
  tokens: GoogleTokens,
  storedDoc: StoredDocument,
  driveDoc: DriveDocument
): Promise<{ updated: boolean; skipped?: boolean; skipReason?: string }> {
  console.log(`  Updating: ${driveDoc.name}`);
  const deadline = makeDeadline(FILE_DEADLINE_MS);

  // Another user's sync may have written this version already — re-check
  // before downloading anything.
  const current = await resolveDocV2(driveDoc.id);
  if (current && current.modifiedTime !== PLACEHOLDER_TIME && current.modifiedTime >= driveDoc.modifiedTime) {
    await upsertUserAccess(userId, current.id);
    console.log(`    Already up to date (synced by another user)`);
    return { updated: true };
  }

  const result = await extractText(tokens, driveDoc);
  if (!result.success) {
    if (result.skip) {
      console.log(`    Skipping: ${result.reason}`);
      // We can no longer process this file — drop this user's access to the
      // stale index (the documents_v2 row survives for other users)
      await removeUserAccess(userId, driveDoc.id);
      return { updated: false, skipped: true, skipReason: result.reason };
    }
    throw new Error(result.error);
  }

  const text = result.text;
  if (!text || text.trim().length === 0) {
    console.log(`    Skipping empty document: ${driveDoc.name}`);
    await removeUserAccess(userId, driveDoc.id);
    return { updated: false, skipped: true, skipReason: "Document is empty" };
  }

  // Unlike other skips, an oversized doc keeps its existing index: deleting
  // it would vanish a doc from search the day it grows past the cap. The
  // stored timestamp stays stale, so we re-check on every sync and resume
  // updating if the file shrinks back under the limit (e.g. gets split).
  const oversize = oversizeReason(text);
  if (oversize) {
    console.log(`    Skipping (existing index kept): ${oversize}`);
    return {
      updated: false,
      skipped: true,
      skipReason: `${oversize} — new content is no longer indexed; the previously indexed version remains searchable`,
    };
  }

  const written = await writeDocumentV2(userId, driveDoc.id, driveDoc.name, text, driveDoc.modifiedTime, deadline);
  console.log(`    Updated (${written.embedded} embedded, ${written.reused} reused)`);
  return { updated: true };
}

async function deleteDocument(storedDoc: StoredDocument, userId: string): Promise<void> {
  console.log(`  Removing access: ${storedDoc.google_doc_id}`);
  // The user lost access in Drive — drop only their access row. The document
  // and its vectors survive for other users (or as a reclaimable orphan).
  await removeUserAccess(userId, storedDoc.google_doc_id);
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

  // Keep V2 heartbeat alive for the entire sync duration (covers discovery + processing)
  const heartbeatInterval = setInterval(() => {
    updateV2Heartbeat(user.userId).catch(() => {});
  }, 30_000);

  try {
    await ensureContentHashColumns();

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
      driveDocs = await listSupportedFiles(activeTokens);
    } catch (error: any) {
      console.error(`  Failed to fetch Google Drive files: ${error.message}`);
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
    console.log(`  Found ${driveDocs.length} supported files in Google Drive`);

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
    let filesSkipped = 0;
    let filesAdded = 0;
    let filesUpdated = 0;

    for (const doc of toDelete) {
      await deleteDocument(doc, user.userId);
    }

    for (const doc of toAdd) {
      try {
        await markFileProcessing(user.userId, doc.id);
        const indexResult = await indexDocument(user.userId, activeTokens, doc);
        if (indexResult.skipped) {
          await markFileSkipped(user.userId, doc.id, indexResult.skipReason || "Skipped");
          filesSkipped++;
        } else {
          await markFileCompleted(user.userId, doc.id);
          filesAdded++;
        }
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
        const updateResult = await updateDocument(user.userId, activeTokens, stored, drive);
        if (updateResult.skipped) {
          await markFileSkipped(user.userId, drive.id, updateResult.skipReason || "Skipped");
          filesSkipped++;
        } else {
          await markFileCompleted(user.userId, drive.id);
          filesUpdated++;
        }
        filesProcessed++;
      } catch (e: any) {
        await markFileFailed(user.userId, drive.id, e.message || "Unknown error");
        filesFailed++;
        console.error(`    Failed to update ${drive.name}: ${e.message}`);
      }
      await updateV2Progress(user.userId, filesProcessed, filesFailed);
    }

    const result = { added: filesAdded, updated: filesUpdated, deleted: toDelete.length };
    await markSyncCompleted(user.userId, result);
    return result;

  } catch (error: any) {
    console.error(`  Sync failed with error: ${error.message}`);
    await markSyncFailed(user.userId, error.message);
    throw error;
  } finally {
    clearInterval(heartbeatInterval);
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
