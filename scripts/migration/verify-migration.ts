#!/usr/bin/env bun
/**
 * Verify Migration: Validate data integrity between old and new tables.
 *
 * This script checks:
 * - Row counts match expectations
 * - All users have sync state migrated
 * - All documents have access mappings
 * - Vector embeddings exist in new table
 * - Sample vector search works on both tables
 *
 * Usage:
 *   bun scripts/migration/verify-migration.ts
 *
 * Requires TURSO_URL and TURSO_AUTH_TOKEN environment variables.
 */

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

interface VerificationResult {
  name: string;
  passed: boolean;
  details: string;
}

async function main() {
  console.log("Verifying migration integrity...\n");

  const results: VerificationResult[] = [];

  // 1. Count comparisons
  console.log("1. Checking row counts...\n");

  // Old tables
  const oldDocCount = await db.execute(`SELECT COUNT(*) as count FROM documents`);
  const oldChunkCount = await db.execute(`SELECT COUNT(*) as count FROM chunks`);
  const oldSyncCount = await db.execute(`SELECT COUNT(*) as count FROM sync_status`);

  // New tables
  const newDocCount = await db.execute(`SELECT COUNT(*) as count FROM documents_v2`);
  const newChunkCount = await db.execute(`SELECT COUNT(*) as count FROM document_vectors`);
  const newSyncCount = await db.execute(`SELECT COUNT(*) as count FROM user_sync_state`);
  const accessCount = await db.execute(`SELECT COUNT(*) as count FROM user_document_access`);

  // Unique google_doc_ids in old table
  const uniqueGoogleIds = await db.execute(`SELECT COUNT(DISTINCT google_doc_id) as count FROM documents`);

  console.log("  Old tables:");
  console.log(`    documents: ${oldDocCount.rows[0]?.count}`);
  console.log(`    chunks: ${oldChunkCount.rows[0]?.count}`);
  console.log(`    sync_status: ${oldSyncCount.rows[0]?.count}`);

  console.log("\n  New tables:");
  console.log(`    documents_v2: ${newDocCount.rows[0]?.count}`);
  console.log(`    document_vectors: ${newChunkCount.rows[0]?.count}`);
  console.log(`    user_sync_state: ${newSyncCount.rows[0]?.count}`);
  console.log(`    user_document_access: ${accessCount.rows[0]?.count}`);

  console.log("\n  Derived:");
  console.log(`    Unique google_doc_ids: ${uniqueGoogleIds.rows[0]?.count}`);
  console.log("");

  // Verify documents_v2 matches unique google_doc_ids
  const expectedDocV2Count = uniqueGoogleIds.rows[0]?.count as number;
  const actualDocV2Count = newDocCount.rows[0]?.count as number;
  results.push({
    name: "documents_v2 count matches unique google_doc_ids",
    passed: expectedDocV2Count === actualDocV2Count,
    details: `Expected: ${expectedDocV2Count}, Actual: ${actualDocV2Count}`,
  });

  // Verify chunk counts match
  const expectedChunkCount = oldChunkCount.rows[0]?.count as number;
  const actualChunkCount = newChunkCount.rows[0]?.count as number;
  results.push({
    name: "document_vectors count matches chunks",
    passed: expectedChunkCount === actualChunkCount,
    details: `Expected: ${expectedChunkCount}, Actual: ${actualChunkCount}`,
  });

  // Verify sync status migration
  const expectedSyncCount = oldSyncCount.rows[0]?.count as number;
  const actualSyncCount = newSyncCount.rows[0]?.count as number;
  results.push({
    name: "user_sync_state count matches sync_status",
    passed: expectedSyncCount === actualSyncCount,
    details: `Expected: ${expectedSyncCount}, Actual: ${actualSyncCount}`,
  });

  // 2. Verify access mappings cover all user-document pairs
  console.log("2. Checking user-document access mappings...\n");

  const userDocPairs = await db.execute(`
    SELECT COUNT(DISTINCT user_id || ':' || google_doc_id) as count FROM documents
  `);
  const expectedPairs = userDocPairs.rows[0]?.count as number;
  const actualPairs = accessCount.rows[0]?.count as number;

  results.push({
    name: "user_document_access covers all user-document pairs",
    passed: expectedPairs === actualPairs,
    details: `Expected: ${expectedPairs}, Actual: ${actualPairs}`,
  });

  console.log(`  User-document pairs in old table: ${expectedPairs}`);
  console.log(`  Access mappings in new table: ${actualPairs}\n`);

  // 3. Verify embeddings exist
  console.log("3. Checking vector embeddings...\n");

  const oldEmbeddingCount = await db.execute(`
    SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL
  `);
  const newEmbeddingCount = await db.execute(`
    SELECT COUNT(*) as count FROM document_vectors WHERE embedding IS NOT NULL
  `);

  const expectedEmbeddings = oldEmbeddingCount.rows[0]?.count as number;
  const actualEmbeddings = newEmbeddingCount.rows[0]?.count as number;

  results.push({
    name: "Embeddings migrated correctly",
    passed: expectedEmbeddings === actualEmbeddings,
    details: `Expected: ${expectedEmbeddings}, Actual: ${actualEmbeddings}`,
  });

  console.log(`  Chunks with embeddings (old): ${expectedEmbeddings}`);
  console.log(`  document_vectors with embeddings (new): ${actualEmbeddings}\n`);

  // 4. Sample some documents to verify content matches
  console.log("4. Spot-checking document content...\n");

  const sampleDocs = await db.execute(`
    SELECT google_doc_id, title, full_text FROM documents LIMIT 3
  `);

  let contentMatches = 0;
  for (const oldDoc of sampleDocs.rows) {
    const newDoc = await db.execute({
      sql: `SELECT title, full_text FROM documents_v2 WHERE google_doc_id = ?`,
      args: [oldDoc.google_doc_id],
    });

    if (newDoc.rows.length > 0) {
      const match =
        newDoc.rows[0]!.title === oldDoc.title &&
        newDoc.rows[0]!.full_text === oldDoc.full_text;
      if (match) contentMatches++;
      console.log(`  ${oldDoc.google_doc_id}: ${match ? "✓" : "✗"} content matches`);
    }
  }

  results.push({
    name: "Sample document content matches",
    passed: contentMatches === sampleDocs.rows.length,
    details: `${contentMatches}/${sampleDocs.rows.length} documents verified`,
  });
  console.log("");

  // 5. Test vector search on both tables (if we have embeddings)
  console.log("5. Testing vector search capability...\n");

  if (expectedEmbeddings > 0) {
    // Get a sample embedding from old table
    const sampleChunk = await db.execute(`
      SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1
    `);

    if (sampleChunk.rows.length > 0 && sampleChunk.rows[0]!.embedding) {
      try {
        // Test search on old table
        const oldSearchResult = await db.execute({
          sql: `SELECT id, vector_distance_cos(embedding, ?) as distance
                FROM chunks
                WHERE embedding IS NOT NULL
                LIMIT 5`,
          args: [sampleChunk.rows[0]!.embedding],
        });

        // Test search on new table
        const newSearchResult = await db.execute({
          sql: `SELECT id, vector_distance_cos(embedding, ?) as distance
                FROM document_vectors
                WHERE embedding IS NOT NULL
                LIMIT 5`,
          args: [sampleChunk.rows[0]!.embedding],
        });

        const oldSearchWorks = oldSearchResult.rows.length > 0;
        const newSearchWorks = newSearchResult.rows.length > 0;

        results.push({
          name: "Vector search works on old table",
          passed: oldSearchWorks,
          details: oldSearchWorks ? `${oldSearchResult.rows.length} results` : "No results",
        });

        results.push({
          name: "Vector search works on new table",
          passed: newSearchWorks,
          details: newSearchWorks ? `${newSearchResult.rows.length} results` : "No results",
        });

        console.log(`  Old table (chunks): ${oldSearchWorks ? "✓" : "✗"} vector search works`);
        console.log(`  New table (document_vectors): ${newSearchWorks ? "✓" : "✗"} vector search works\n`);
      } catch (err: any) {
        console.log(`  Error testing vector search: ${err.message}\n`);
        results.push({
          name: "Vector search works",
          passed: false,
          details: err.message,
        });
      }
    }
  } else {
    console.log("  No embeddings to test vector search\n");
  }

  // Summary
  console.log("========================================");
  console.log("Verification Results");
  console.log("========================================\n");

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`${status}: ${result.name}`);
    console.log(`        ${result.details}\n`);

    if (result.passed) passed++;
    else failed++;
  }

  console.log("========================================");
  console.log(`Total: ${passed} passed, ${failed} failed`);
  console.log("========================================\n");

  if (failed > 0) {
    console.log("⚠️  Some verifications failed. Review the results above.");
    console.log("   Consider running rollback-phase2.ts and re-running the migration.");
    process.exit(1);
  } else {
    console.log("✅ All verifications passed!");
    console.log("\nNext steps:");
    console.log("  1. Deploy dual-write code (Phase 3)");
    console.log("  2. Set USE_NEW_VECTOR_TABLE=true to enable new search");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
