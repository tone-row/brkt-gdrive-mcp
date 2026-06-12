import { db, withRetry } from "../db/client";
import { listSupportedFiles, exportDocAsText, exportSheetAsXlsx, downloadFile, refreshTokensIfNeeded, type DriveDocument, type GoogleTokens, type RefreshedTokens } from "./google-drive";
import { extractTextFromPdf, extractTextFromDocx, extractTextFromDoc, extractTextFromSpreadsheet } from "./extractors";
import { chunkText } from "./chunker";
import { generateEmbeddings } from "./embeddings";
import { hashChunk, diffChunks, type NewChunk } from "./chunk-diff";
import { chunkRowId, loadExistingChunks, makeDeadline, checkDeadline } from "./chunk-store";
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
import { v4 as uuid } from "uuid";
import { v2TablesExist, writeDocumentToV2, updateDocumentInV2, removeUserAccessFromV2 } from "./dual-write";

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

// Chunks per OpenAI embeddings request
const EMBED_BATCH_SIZE = 20;
// Chunk rows per Turso batch write. Kept small: every row triggers a DiskANN
// vector-index update server-side, observed at roughly 2-5s per row.
const INSERT_BATCH_SIZE = 5;
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

// Self-healing migration: the incremental chunk diff needs a content_hash
// column. Additive only — existing rows get hashes backfilled lazily from
// their stored text the first time their document is updated.
let contentHashEnsured = false;
async function ensureContentHashColumns(): Promise<void> {
  if (contentHashEnsured) return;
  for (const table of ["chunks", "document_vectors"]) {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN content_hash TEXT`);
      console.log(`[Schema] Added content_hash column to ${table}`);
    } catch (error: any) {
      if (!/duplicate column|no such table/i.test(error.message || "")) {
        throw error;
      }
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

interface ChunkSyncResult {
  /** Full chunk list for the new text (hashes included, no embeddings) */
  chunks: NewChunk[];
  /** Embeddings generated this run, keyed by content hash */
  embeddingsByHash: Map<string, number[]>;
  /** How many chunks were reused without re-embedding */
  reused: number;
}

/**
 * Bring the chunks table in line with the document's new text, incrementally.
 *
 * Only chunks whose content hash isn't already stored get embedded and
 * inserted; unchanged chunks are left untouched (append-heavy docs re-embed
 * just the tail). New chunks are inserted BEFORE stale ones are deleted, so a
 * crash at any point leaves the search index intact-or-better — the document's
 * stale timestamp makes the next sync converge.
 *
 * Exported for tests.
 */
export async function syncChunksIncrementally(
  docId: string,
  userId: string,
  text: string,
  deadline: number
): Promise<ChunkSyncResult> {
  const chunks: NewChunk[] = chunkText(text).map((c) => ({
    index: c.index,
    text: c.text,
    hash: hashChunk(c.text),
  }));

  const existing = await loadExistingChunks("chunks", docId);
  const diff = diffChunks(existing, chunks);
  console.log(
    `    Chunk diff: ${diff.kept} unchanged, ${diff.toEmbed.length} to embed, ${diff.toReindex.length} moved, ${diff.toDelete.length} stale`
  );

  const embeddingsByHash = new Map<string, number[]>();

  for (let i = 0; i < diff.toEmbed.length; i += EMBED_BATCH_SIZE) {
    checkDeadline(deadline, "embedding chunks");
    const batch = diff.toEmbed.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await generateEmbeddings(batch.map((c) => c.text));
    batch.forEach((c, j) => embeddingsByHash.set(c.hash, embeddings[j]!));

    for (let j = 0; j < batch.length; j += INSERT_BATCH_SIZE) {
      checkDeadline(deadline, "inserting chunks");
      const rows = batch.slice(j, j + INSERT_BATCH_SIZE);
      await withRetry("insert chunks", () =>
        db.batch(
          rows.map((c, k) => ({
            sql: `INSERT OR IGNORE INTO chunks (id, document_id, user_id, chunk_index, text, embedding, content_hash)
                  VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
            args: [
              chunkRowId(docId, c.index, c.hash),
              docId,
              userId,
              c.index,
              c.text,
              `[${embeddings[j + k]!.join(",")}]`,
              c.hash,
            ],
          })),
          "write"
        )
      );
    }
  }

  if (diff.toReindex.length > 0) {
    await withRetry("reindex chunks", () =>
      db.batch(
        diff.toReindex.map((m) => ({
          sql: `UPDATE chunks SET chunk_index = ? WHERE id = ?`,
          args: [m.newIndex, m.id],
        })),
        "write"
      )
    );
  }

  for (let i = 0; i < diff.toDelete.length; i += 100) {
    const ids = diff.toDelete.slice(i, i + 100);
    await withRetry("delete stale chunks", () =>
      db.execute({
        sql: `DELETE FROM chunks WHERE id IN (${ids.map(() => "?").join(",")})`,
        args: ids,
      })
    );
  }

  return { chunks, embeddingsByHash, reused: diff.kept + diff.toReindex.length };
}

async function indexDocument(
  userId: string,
  tokens: GoogleTokens,
  doc: DriveDocument
): Promise<{ indexed: boolean; skipped?: boolean; skipReason?: string }> {
  console.log(`  Indexing: ${doc.name}`);
  const deadline = makeDeadline(FILE_DEADLINE_MS);

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

  const docId = uuid();

  // Insert document with a placeholder timestamp - we'll update it AFTER all chunks succeed.
  // This ensures that if we die mid-chunks, the next sync will see this doc needs re-indexing.
  const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z";
  // OR IGNORE keeps the retried insert idempotent if a timeout fired after
  // the server actually committed
  await withRetry("insert document", () =>
    db.execute({
      sql: `INSERT OR IGNORE INTO documents (id, user_id, google_doc_id, title, full_text, google_modified_time)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [docId, userId, doc.id, doc.name, text, PLACEHOLDER_TIME],
    })
  );

  const chunkResult = await syncChunksIncrementally(docId, userId, text, deadline);

  // NOW update the timestamp - all chunks succeeded
  await withRetry("finalize document", () =>
    db.execute({
      sql: `UPDATE documents SET google_modified_time = ? WHERE id = ?`,
      args: [doc.modifiedTime, docId],
    })
  );

  console.log(`    Indexed ${chunkResult.chunks.length} chunks (${chunkResult.embeddingsByHash.size} embedded)`);

  // Dual-write to V2 tables (non-blocking, errors are logged but don't fail sync)
  if (await isDualWriteEnabled()) {
    await writeDocumentToV2(userId, doc.id, doc.name, text, doc.modifiedTime, chunkResult.chunks, chunkResult.embeddingsByHash, docId);
  }

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

  const result = await extractText(tokens, driveDoc);
  if (!result.success) {
    if (result.skip) {
      console.log(`    Skipping: ${result.reason}`);
      // Delete the stored doc since we can no longer process this file
      await db.execute({
        sql: "DELETE FROM documents WHERE id = ?",
        args: [storedDoc.id],
      });
      if (await isDualWriteEnabled()) {
        await removeUserAccessFromV2(userId, driveDoc.id);
      }
      return { updated: false, skipped: true, skipReason: result.reason };
    }
    throw new Error(result.error);
  }

  const text = result.text;
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

  // Update document content but NOT the timestamp yet.
  // We'll update timestamp AFTER all chunks succeed.
  // This ensures if we die mid-chunks, next sync will re-index this doc.
  await withRetry("update document", () =>
    db.execute({
      sql: `UPDATE documents
            SET title = ?, full_text = ?, updated_at = datetime('now')
            WHERE id = ?`,
      args: [driveDoc.name, text, storedDoc.id],
    })
  );

  // Incremental: unchanged chunks stay in place, only new content is embedded,
  // and stale chunks are deleted only after their replacements are inserted.
  const chunkResult = await syncChunksIncrementally(storedDoc.id, userId, text, deadline);

  // NOW update the timestamp - all chunks succeeded
  await withRetry("finalize document", () =>
    db.execute({
      sql: `UPDATE documents SET google_modified_time = ? WHERE id = ?`,
      args: [driveDoc.modifiedTime, storedDoc.id],
    })
  );

  console.log(`    Updated: ${chunkResult.chunks.length} chunks (${chunkResult.embeddingsByHash.size} embedded, ${chunkResult.reused} reused)`);

  // Dual-write to V2 tables (non-blocking, errors are logged but don't fail sync)
  if (await isDualWriteEnabled()) {
    await updateDocumentInV2(userId, driveDoc.id, driveDoc.name, text, driveDoc.modifiedTime, chunkResult.chunks, chunkResult.embeddingsByHash, storedDoc.id);
  }

  return { updated: true };
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
