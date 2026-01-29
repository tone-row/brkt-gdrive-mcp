# Google Drive Indexing & Sync Architecture Guide

## Overview

This document outlines the recommended architecture for a system that indexes Google Drive files into a vector database, supporting multiple users with shared document deduplication and resilient long-running processes.

---

## Core Problem

The current implementation uses a synchronous mental model for an inherently asynchronous process. This leads to:
- Client state becoming out of sync with actual processing state
- No visibility into partial progress
- No ability to resume after failures or timeouts
- Unclear state when processes hang or crash

## Architectural Principles

1. **Treat indexing as a job queue, not request/response**
2. **Make all work resumable at the file level**
3. **Use heartbeats to detect stalled workers**
4. **Separate document storage from user access (for deduplication)**
5. **The database is the source of truth, not the running process**

---

## Database Schema

### Core Tables

```sql
-- Track overall sync state per user
CREATE TABLE user_sync_state (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',  
  -- 'idle' | 'discovering' | 'processing' | 'completed' | 'failed'
  
  discovery_started_at DATETIME,
  processing_started_at DATETIME,
  completed_at DATETIME,
  
  -- Worker tracking for heartbeat pattern
  worker_id TEXT,
  worker_heartbeat_at DATETIME,
  
  -- Stats for client display
  total_files_discovered INTEGER DEFAULT 0,
  files_processed INTEGER DEFAULT 0,
  files_failed INTEGER DEFAULT 0,
  
  last_successful_sync_at DATETIME,
  last_google_change_token TEXT,  -- For incremental sync via Changes API
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Individual file processing queue
CREATE TABLE file_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  google_file_id TEXT NOT NULL,
  
  status TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  
  -- Job metadata
  file_name TEXT,
  mime_type TEXT,
  google_md5_checksum TEXT,  -- For change detection
  
  -- Worker tracking
  claimed_by TEXT,  -- worker_id
  claimed_at DATETIME,
  completed_at DATETIME,
  
  -- Retry handling
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  error_message TEXT,
  
  -- Deduplication tracking
  document_id INTEGER,  -- FK to documents table (set after processing)
  skipped_reason TEXT,  -- 'already_indexed' | 'unsupported_type' | etc.
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id, google_file_id)
);

CREATE INDEX idx_file_jobs_status ON file_jobs(user_id, status);
CREATE INDEX idx_file_jobs_claimed ON file_jobs(status, claimed_at);
```

### Shared Document Tables (for deduplication)

```sql
-- Canonical document storage (deduplicated across users)
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_file_id TEXT UNIQUE NOT NULL,  -- Globally unique in Google
  
  -- Content tracking
  content_hash TEXT NOT NULL,  -- md5 from Google, used for change detection
  file_name TEXT,
  mime_type TEXT,
  
  -- Processing metadata
  last_indexed_at DATETIME,
  chunk_count INTEGER DEFAULT 0,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Which users have access to which documents
CREATE TABLE user_document_access (
  user_id TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  google_file_id TEXT NOT NULL,  -- Denormalized for query convenience
  
  -- Access metadata from Google
  access_type TEXT,  -- 'owner' | 'writer' | 'reader'
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME,  -- Updated each sync to track if still accessible
  
  PRIMARY KEY (user_id, document_id)
);

CREATE INDEX idx_user_document_access_user ON user_document_access(user_id);
CREATE INDEX idx_user_document_access_doc ON user_document_access(document_id);

-- Vector chunks linked to documents (not users)
CREATE TABLE document_vectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT,
  embedding BLOB,  -- Or however your vector DB stores this
  
  metadata TEXT,  -- JSON blob for additional chunk metadata
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(document_id, chunk_index)
);

CREATE INDEX idx_document_vectors_doc ON document_vectors(document_id);
```

---

## Turso-Specific Considerations

Turso uses libSQL and handles replication automatically. Key considerations:

### Consistency for Job Claiming

Turso is eventually consistent by default. For job queue operations, **use strong consistency**:

```javascript
// When claiming jobs or checking sync state, read from primary
const result = await turso.execute({
  sql: "SELECT * FROM file_jobs WHERE status = 'pending' LIMIT 1",
  consistency: "strong"  // Or use primary connection
});
```

### Atomic Job Claiming

Use RETURNING to atomically claim and retrieve a job:

```sql
UPDATE file_jobs 
SET 
  status = 'processing', 
  claimed_by = :worker_id, 
  claimed_at = CURRENT_TIMESTAMP
WHERE id = (
  SELECT id FROM file_jobs 
  WHERE user_id = :user_id 
    AND status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *;
```

### Connection Handling

- Keep transactions short—don't hold connections while calling external APIs
- Use connection pooling appropriate for your worker count
- Turso handles WAL mode internally; no manual configuration needed

---

## Worker Implementation

### Heartbeat Pattern

The heartbeat solves the "hanging state" problem. Workers must:

1. **Register when starting work:**
```javascript
await db.execute(`
  UPDATE user_sync_state 
  SET worker_id = ?, worker_heartbeat_at = CURRENT_TIMESTAMP, status = 'processing'
  WHERE user_id = ?
`, [workerId, userId]);
```

2. **Update heartbeat periodically (every 30-60 seconds):**
```javascript
// Run this in a setInterval during processing
await db.execute(`
  UPDATE user_sync_state 
  SET worker_heartbeat_at = CURRENT_TIMESTAMP
  WHERE user_id = ? AND worker_id = ?
`, [userId, workerId]);
```

3. **Check for stale workers before starting:**
```javascript
const HEARTBEAT_TIMEOUT_SECONDS = 120;

const staleCheck = await db.execute(`
  SELECT * FROM user_sync_state 
  WHERE user_id = ? 
    AND status = 'processing'
    AND worker_heartbeat_at < datetime('now', '-${HEARTBEAT_TIMEOUT_SECONDS} seconds')
`, [userId]);

if (staleCheck.rows.length > 0) {
  // Previous worker died, recover orphaned jobs
  await recoverOrphanedJobs(userId);
}
```

### Recovery Flow

```javascript
async function recoverOrphanedJobs(userId) {
  // Reset jobs that were being processed by dead worker
  await db.execute(`
    UPDATE file_jobs 
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL
    WHERE user_id = ?
      AND status = 'processing'
      AND retry_count < max_retries
  `, [userId]);
  
  // Mark jobs that exceeded retries as failed
  await db.execute(`
    UPDATE file_jobs 
    SET status = 'failed', error_message = 'Max retries exceeded'
    WHERE user_id = ?
      AND status = 'processing'
      AND retry_count >= max_retries
  `, [userId]);
}
```

### Main Worker Loop

```javascript
async function processUserSync(userId, workerId) {
  // 1. Check if we can claim this sync (or recover stale one)
  const canProceed = await claimOrRecoverSync(userId, workerId);
  if (!canProceed) return;
  
  // 2. Start heartbeat interval
  const heartbeatInterval = setInterval(() => {
    updateHeartbeat(userId, workerId);
  }, 30000);
  
  try {
    // 3. Discovery phase (if needed)
    await discoverFiles(userId);
    
    // 4. Processing phase - one file at a time
    while (true) {
      const job = await claimNextJob(userId, workerId);
      if (!job) break;  // No more pending jobs
      
      try {
        await processFileJob(job);
        await markJobCompleted(job.id);
      } catch (error) {
        await markJobFailed(job.id, error.message);
      }
      
      // Update progress stats
      await updateSyncProgress(userId);
    }
    
    // 5. Mark sync completed
    await completSync(userId);
    
  } finally {
    clearInterval(heartbeatInterval);
  }
}
```

---

## Shared Document Deduplication

### Processing Logic

When processing a file, check for existing indexed version:

```javascript
async function processFileJob(job) {
  const { google_file_id, google_md5_checksum, user_id } = job;
  
  // Check if document already exists
  const existing = await db.execute(`
    SELECT id, content_hash FROM documents 
    WHERE google_file_id = ?
  `, [google_file_id]);
  
  if (existing.rows.length > 0) {
    const doc = existing.rows[0];
    
    if (doc.content_hash === google_md5_checksum) {
      // Document unchanged, just add access record
      await addUserAccess(user_id, doc.id, google_file_id);
      await markJobSkipped(job.id, 'already_indexed', doc.id);
      return;
    } else {
      // Document changed, re-index
      await deleteDocumentVectors(doc.id);
      await reindexDocument(doc.id, job);
      await addUserAccess(user_id, doc.id, google_file_id);
      return;
    }
  }
  
  // New document, full indexing
  const docId = await indexNewDocument(job);
  await addUserAccess(user_id, docId, google_file_id);
}
```

### Querying Vectors for a User

When searching, join through access table:

```sql
SELECT dv.*, d.file_name, d.google_file_id
FROM document_vectors dv
JOIN documents d ON dv.document_id = d.id
JOIN user_document_access uda ON d.id = uda.document_id
WHERE uda.user_id = :user_id
  AND dv.embedding <-> :query_embedding < :threshold
ORDER BY dv.embedding <-> :query_embedding
LIMIT :limit;
```

### Handling Access Removal

When a user no longer has access to a document:

```javascript
async function handleAccessRemoval(userId, googleFileId) {
  // Remove access record
  await db.execute(`
    DELETE FROM user_document_access 
    WHERE user_id = ? AND google_file_id = ?
  `, [userId, googleFileId]);
  
  // Check if anyone else still has access
  const remaining = await db.execute(`
    SELECT COUNT(*) as count FROM user_document_access 
    WHERE google_file_id = ?
  `, [googleFileId]);
  
  if (remaining.rows[0].count === 0) {
    // No one has access, clean up document and vectors
    await db.execute(`
      DELETE FROM documents WHERE google_file_id = ?
    `, [googleFileId]);
    // Vectors deleted via CASCADE
  }
}
```

---

## Client-Side Integration

### Status Endpoint

Provide a simple polling endpoint:

```javascript
// GET /api/users/:userId/sync-status
async function getSyncStatus(userId) {
  const state = await db.execute(`
    SELECT 
      status,
      total_files_discovered,
      files_processed,
      files_failed,
      last_successful_sync_at,
      worker_heartbeat_at,
      CASE 
        WHEN status = 'processing' 
         AND worker_heartbeat_at > datetime('now', '-120 seconds')
        THEN 1 ELSE 0 
      END as worker_alive
    FROM user_sync_state
    WHERE user_id = ?
  `, [userId]);
  
  return state.rows[0] || { status: 'idle', worker_alive: false };
}
```

### Client Display Logic

```javascript
function SyncStatus({ status }) {
  if (status.status === 'idle') {
    return <span>Up to date (last sync: {status.last_successful_sync_at})</span>;
  }
  
  if (status.status === 'discovering') {
    return <span>Scanning Google Drive...</span>;
  }
  
  if (status.status === 'processing') {
    if (!status.worker_alive) {
      return <span>Sync stalled - will auto-recover</span>;
    }
    const progress = status.files_processed / status.total_files_discovered * 100;
    return <span>Indexing: {status.files_processed}/{status.total_files_discovered} ({progress.toFixed(0)}%)</span>;
  }
  
  if (status.status === 'failed') {
    return <span>Sync failed ({status.files_failed} errors) - will retry</span>;
  }
}
```

### Manual Trigger

Allow manual sync trigger, but let the system handle the complexity:

```javascript
// POST /api/users/:userId/sync
async function triggerSync(userId) {
  // Don't start if already running (and worker is alive)
  const current = await getSyncStatus(userId);
  if (current.status === 'processing' && current.worker_alive) {
    return { message: 'Sync already in progress' };
  }
  
  // Queue sync job (via your job runner, cron, or direct call)
  await queueSyncJob(userId);
  return { message: 'Sync started' };
}
```

---

## Migration Path

### Phase 1: Add New Tables (Non-Breaking)
1. Create `file_jobs` table alongside existing system
2. Create shared document tables (`documents`, `user_document_access`)
3. Keep existing flow working during migration

### Phase 2: Implement Job-Based Processing
1. Update sync trigger to populate `file_jobs` instead of processing directly
2. Implement worker loop with heartbeat pattern
3. Update status endpoint to read from new tables

### Phase 3: Migrate Existing Data
1. For existing vectors, create `documents` and `user_document_access` records
2. Re-link vectors to new document IDs
3. Deduplicate any shared documents

### Phase 4: Clean Up
1. Remove old status tracking columns/tables
2. Remove old processing code paths
3. Update all clients to new status format

---

## Operational Considerations

### Monitoring
- Alert if any user has `status = 'processing'` with stale heartbeat for > 10 minutes
- Track job completion rates and average processing time
- Monitor retry rates to catch systematic failures

### Scaling Beyond 100 Users
The architecture above scales well. When you need more:
1. **Multiple workers**: The job claiming pattern supports concurrent workers
2. **PostgreSQL migration**: Same schema, better concurrent write handling with `SELECT FOR UPDATE SKIP LOCKED`
3. **Dedicated job queue**: BullMQ, pg-boss, or similar if you need more sophisticated scheduling

### Timeouts
- Set reasonable timeouts on Google API calls (30s)
- Set reasonable timeouts on embedding API calls (60s per file)
- Let the job retry mechanism handle transient failures
- The 5-minute global timeout is no longer needed—each file is independent

---

## Summary

The key shifts from current architecture:

| Current | Recommended |
|---------|-------------|
| Binary "is processing" flag | Granular per-file job status |
| Client guesses at progress | Client reads actual progress from DB |
| Timeout kills everything | Individual files can fail/retry independently |
| Unclear if process died | Heartbeat detects dead workers |
| Same doc indexed per user | Shared documents indexed once |
| Recovery requires manual intervention | Self-healing via job reclaim |

This architecture handles the initial "index entire Drive" case gracefully—it just means more jobs in the queue, all with individual progress tracking and retry capability.
