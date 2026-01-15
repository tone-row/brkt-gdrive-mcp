import { db } from "../db/client";
import { runMigrations } from "../db/schema";
import { listGoogleDocs, exportDocAsText, type DriveDocument, type GoogleTokens } from "./google-drive";
import { chunkText } from "./chunker";
import { generateEmbeddings } from "./embeddings";
import { v4 as uuid } from "uuid";

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
async function syncUser(user: UserWithTokens): Promise<{ added: number; updated: number; deleted: number }> {
  console.log(`\nSyncing user: ${user.email}`);

  // Get current state from database for this user
  const storedDocs = await getStoredDocuments(user.userId);
  console.log(`  Found ${storedDocs.size} documents in database`);

  // Get current state from Google Drive
  let driveDocs: DriveDocument[];
  try {
    driveDocs = await listGoogleDocs(user.tokens);
  } catch (error: any) {
    console.error(`  Failed to fetch Google Drive docs: ${error.message}`);
    // TODO: Mark account as needing re-auth if token expired
    return { added: 0, updated: 0, deleted: 0 };
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
    await indexDocument(user.userId, user.tokens, doc);
  }

  // Process updates
  for (const { stored, drive } of toUpdate) {
    await updateDocument(user.userId, user.tokens, stored, drive);
  }

  return { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length };
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
      WHERE u.id = ? AND a.provider_id = 'google' AND a.access_token IS NOT NULL
    `,
    args: [userId],
  });

  if (result.rows.length === 0) {
    throw new Error("User not found or Google account not connected");
  }

  const row = result.rows[0]!;
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
