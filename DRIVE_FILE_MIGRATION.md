# drive.file Migration Plan

A jumping-off point for migrating Loft from `drive.readonly` to `drive.file` + Google Picker, after Google's verification team pushed back on the restricted scope.

---

## Background

Google rejected the `https://www.googleapis.com/auth/drive.readonly` request during OAuth verification. Their email recommended `drive.file` + Google Picker instead. Key points from their response:

- `drive.readonly` is **restricted** — requires CASA security assessment (~$5–15k, annually) plus full app verification.
- `drive.file` is **non-sensitive** — no verification, no CASA, no ongoing recertification.
- "UI preferences or client library limitations alone are not valid policy exceptions" — they will not accept "we need automatic indexing for the UX to work" as a justification.
- They explicitly suggested creating a *new Google Cloud project for testing* so the existing verification request stays intact while we experiment.

The big win if we move to `drive.file`: **the verification headache disappears entirely.** No more demo videos, no scope justifications, no review queues.

---

## Goals

**What we want:**
- Same product (semantic search over user's Google Docs) without the restricted scope
- Onboarding flow where users explicitly select which folders to make searchable
- New folders/files added to those picked folders are picked up automatically on subsequent syncs
- Users can add or remove picked folders later without losing other state

**What we accept losing:**
- "Connect once and everything is searchable" — replaced with "pick the folders you want searchable"
- Auto-discovery of brand new top-level folders (users have to re-pick to add new ones)

**What we explicitly do NOT do:**
- Maintain backwards compatibility with `drive.readonly` — clean break
- Run both scopes side-by-side — Google will reject that and it doubles the surface area
- Try to "trick" the picker into giving us everything — we comply with the spirit of `drive.file`

---

## Architecture changes (high level)

### Today (drive.readonly)
1. User signs in with Google → Better Auth requests `drive.readonly` + profile
2. Sync server lists **all** Google Docs in user's Drive via `files.list({ q: "mimeType='application/vnd.google-apps.document'" })`
3. Each doc exported as text, chunked, embedded, stored

### After migration (drive.file)
1. User signs in with Google → Better Auth requests `drive.file` + profile
2. User is taken to onboarding — must open Google Picker and select one or more folders
3. Picked folder IDs are stored in DB (`picked_resources` table)
4. Sync server walks each picked folder via `files.list({ q: "'<folder_id>' in parents and mimeType=..." })` (recursive for subfolders)
5. Same downstream pipeline: export → chunk → embed → store
6. Settings page lets users add/remove picked folders

---

## Phase 0: Pre-work — new Google Cloud project

Per Google's instructions, do NOT modify the existing `brkt-gdrive-mcp` project until the new flow is proven. Create a fresh project for testing.

### Steps

1. **Create the project**
   - Google Cloud Console → New Project
   - Suggested name: `loft-drive-file` (project ID auto-generated)

2. **Enable APIs**
   - Google Drive API
   - Google Picker API ← *new, not currently enabled*

3. **OAuth consent screen**
   - User type: External
   - App name: Loft (or whatever the production name is)
   - Scopes: only `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file`
   - Test users: add your own Google account
   - **No verification needed** — these are all non-sensitive scopes

4. **OAuth 2.0 Client ID**
   - Application type: Web application
   - Authorized JavaScript origins:
     - `http://localhost:3000`
     - The Vercel preview URL for the migration branch (set after branch is deployed)
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/callback/google`
     - `<preview-url>/api/auth/callback/google`
   - Save the client ID and client secret

5. **API Key for Picker**
   - Credentials → Create credentials → API key
   - Restrict to:
     - Application: HTTP referrers → add localhost and preview URL
     - APIs: Google Picker API only
   - Save the API key (this one is exposed to the frontend, but referrer-restricted)

---

## Phase 1: Branching strategy

### Branch
- Branch name: `drive-file-migration`
- Base: `main`
- Don't merge until end-to-end testing succeeds with a real Google account

### Vercel
- Vercel will auto-deploy the branch as a preview
- Configure preview-specific environment variables (Settings → Environment Variables → "Preview" scope, filter by branch):
  - `GOOGLE_CLIENT_ID` — from new Cloud project
  - `GOOGLE_CLIENT_SECRET` — from new Cloud project
  - `GOOGLE_PICKER_API_KEY` — from new Cloud project (NEW env var)
  - `BETTER_AUTH_URL` — preview URL
  - `NEXT_PUBLIC_APP_URL` — preview URL
  - `TURSO_URL` — points to a Turso branch DB (see below)
  - `TURSO_AUTH_TOKEN` — token for the branch DB
- Once you have the preview URL, go back to the new Cloud project's OAuth client and add the preview URL to authorized origins/redirects

### Turso branch DB
- Use Turso's branch feature to fork production DB into a test branch
- This gives you isolation: the new code can write picked_resources, run syncs, generate embeddings, all without touching prod data
- Schema migrations applied to the branch first; once verified, applied to prod during cutover

### Sync server (Fly.io)
- For now, **don't** deploy the migration branch to Fly.io
- During testing you can either:
  - Run the sync server locally pointed at the branch DB (`bun run` it locally, hit the branch Turso URL)
  - Or spin up a separate Fly.io app for the migration branch
- Easier: run locally during testing

---

## Phase 2: Code changes

### 2.1 Auth config — `www/src/auth/index.ts`

Replace the scope array:
```ts
scope: [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",  // was: drive.readonly
],
```

Everything else stays the same (`accessType: "offline"`, `prompt: "consent"`).

### 2.2 New DB table — `picked_resources`

Add to the schema (likely `www/src/db/schema.ts` or wherever sync state lives — verify file at migration time):

```ts
export const pickedResources = sqliteTable("picked_resources", {
  id: text("id").primaryKey(),                    // uuid
  userId: text("user_id").notNull(),              // FK to user table
  resourceId: text("resource_id").notNull(),     // Google Drive file/folder ID
  resourceType: text("resource_type").notNull(), // 'folder' | 'file'
  resourceName: text("resource_name"),           // human-readable name for UI
  pickedAt: integer("picked_at", { mode: "timestamp" }).notNull(),
});
```

Generate a Drizzle migration:
```bash
bun run drizzle-kit generate
bun run drizzle-kit migrate  # against the Turso branch DB
```

Note: previous OAuth migrations in this repo went through self-healing patterns (see commits `0865182`, `1f521a0`). Follow whatever pattern was used most recently for new tables.

### 2.3 Google Picker integration — frontend

New component: `www/src/components/GoogleDrivePicker.tsx`

Approach:
- Load the Google Identity Services script (`https://accounts.google.com/gsi/client`) and Picker script (`https://apis.google.com/js/api.js`) on demand
- Read the user's current Google access token from Better Auth (it's stored server-side in the `account` table — expose via a server action or API route, e.g. `GET /api/auth/google-token`)
- Initialize the picker with:
  - `setOAuthToken(accessToken)`
  - `setDeveloperKey(NEXT_PUBLIC_GOOGLE_PICKER_API_KEY)`
  - A `DocsView` configured with:
    - `setMimeTypes("application/vnd.google-apps.document,application/vnd.google-apps.folder")`
    - `setSelectFolderEnabled(true)`
    - `setIncludeFolders(true)`
  - `enableFeature(google.picker.Feature.MULTISELECT_ENABLED)`
- On `PICKED` callback, POST the picked items to `/api/picked-resources`

Key references:
- Picker quickstart: https://developers.google.com/drive/picker/guides/overview
- Folder selection: pickers do support folders, but you need both `setSelectFolderEnabled(true)` AND `setIncludeFolders(true)` on the view

### 2.4 New API routes

- `POST /api/picked-resources` — store the user's selections
  - Body: `{ items: [{ id, type, name }] }`
  - Inserts into `picked_resources` table
  - Triggers an immediate sync (or queues one)
- `GET /api/picked-resources` — list current selections for the dashboard
- `DELETE /api/picked-resources/:id` — remove a selection
  - Should also delete associated documents/chunks/embeddings (cascading cleanup)

### 2.5 Sync logic changes — `www/src/sync/google-drive.ts` and `www/src/sync/index.ts`

Replace the "list all docs" logic with "list docs in picked resources":

```ts
// OLD: lists every doc in the user's Drive
const response = await drive.files.list({
  q: "mimeType='application/vnd.google-apps.document' and trashed=false",
  ...
});

// NEW: list docs in each picked folder, plus directly-picked files
async function listDocsForUser(tokens, pickedResources) {
  const docs = [];
  for (const resource of pickedResources) {
    if (resource.resourceType === "folder") {
      docs.push(...await listDocsInFolderRecursive(tokens, resource.resourceId));
    } else {
      docs.push(await getFileMetadata(tokens, resource.resourceId));
    }
  }
  return docs;
}

async function listDocsInFolderRecursive(tokens, folderId) {
  // 1. List all docs directly in this folder
  // 2. List all subfolders
  // 3. Recurse into each subfolder
  // Use 'in parents' query: q: `'${folderId}' in parents and trashed=false`
}
```

Important: the `files.export()` call for getting doc text stays the same. The drive.file scope allows export of files the user has granted access to.

### 2.6 New onboarding UI

Add a new page or modal: "Welcome to Loft — pick the folders you want to search."
- Big "Open Picker" button
- After picking, show selected folders
- "Start syncing" button kicks off first sync
- Cannot proceed without picking at least one resource

### 2.7 Settings page — manage selections

On the dashboard or a `/settings` route:
- List of currently picked folders/files (name + when picked)
- "Add more" button → opens picker again (additive, doesn't replace)
- "Remove" button per row → DELETE + cleanup embeddings

---

## Phase 3: Testing

Test as a real user before declaring victory:

1. **Fresh sign-in flow**
   - Clear cookies, go to preview URL
   - Sign in with a test Google account
   - Verify consent screen shows ONLY: profile, email, "See, edit, create, and delete only the specific Google Drive files you use with this app"
   - Verify NO mention of "all your files"

2. **Picker flow**
   - Open picker, select a folder containing a few Google Docs
   - Verify selection is stored (check DB)
   - Verify sync runs and indexes only those docs

3. **Subfolder coverage**
   - Pick a folder that has subfolders with docs
   - Verify recursive walking finds them all

4. **New file in picked folder**
   - After initial sync, create a new Google Doc in a picked folder
   - Run sync again
   - Verify the new doc is picked up *without* re-picking
   - **This is the most important test** — if drive.file doesn't grant access to files added after the pick, the whole approach breaks

5. **Search via MCP**
   - Connect MCP client (Claude, Cursor, etc.) using the new API key flow
   - Search for content from a picked-folder doc
   - Verify results

6. **Add more folders**
   - From settings, add another folder
   - Verify additive behavior (existing picks remain)

7. **Remove a folder**
   - Remove a folder
   - Verify docs/chunks/embeddings for that folder are deleted

8. **Token refresh**
   - Wait an hour (or manually invalidate the access token)
   - Trigger a sync
   - Verify refresh token still works

---

## Phase 4: Cutover

Once Phase 3 passes end-to-end:

### Option A — Migrate the existing Cloud project (recommended)
- Update the existing `brkt-gdrive-mcp` project's OAuth consent screen to remove `drive.readonly` and add `drive.file`
- Update production env vars on Vercel/Fly.io to remove any drive.readonly assumptions
- Reply to Google's verification email with: "We've migrated to drive.file as recommended. Please cancel our verification request for drive.readonly."
- Merge `drive-file-migration` → `main`
- Deploy to production
- Email existing users: "We've improved how Loft accesses your Drive — please re-connect and select the folders you want indexed."
- Force re-onboarding by clearing existing sessions or showing a one-time setup screen

### Option B — Promote the new Cloud project to production
- Switch production env vars to point at the new Cloud project's credentials
- Same user notification + re-onboarding flow
- Eventually delete the old project (after a cooling-off period in case Google needs to reference it)

Either way: existing users WILL have to re-consent and re-pick. There is no way to grandfather in `drive.readonly` consents — they're tied to scopes baked into the refresh token.

### Existing data
- Old indexed docs in the production DB are still valid but may include docs the user wouldn't have re-picked
- Cleanest approach: wipe documents/chunks/embeddings on cutover, force a fresh sync
- Less disruptive: leave old data in place, let users see "stale" results until first re-sync

I'd lean toward wiping — clean slate matches the new mental model.

---

## Open questions to verify before building

1. **Does drive.file grant access to files added to a picked folder *after* the pick?** This is critical. Test it manually in the Picker playground before committing to the architecture. If the answer is "no," we'd need a periodic re-pick prompt, which is bad UX.

2. **Does drive.file recurse into subfolders?** When you pick a folder, can you list and read files in subfolders, or just the top level? Test this.

3. **Can the existing Better Auth access token be reused for the picker?** Or do we need a separate Google Identity Services token request on the frontend? Investigate Better Auth's account token storage.

4. **Picker referrer restrictions** — make sure the API key referrer pattern matches both Vercel preview URLs (which have dynamic subdomains) and production. May need a wildcard.

5. **Do we want to support PDF / Sheets / Slides?** Current code only does Google Docs. Picker can filter to include other types — but each requires its own export logic. Stay scoped to Docs for v1.

6. **Do we want Shared Drives support?** Picker supports it. Probably out of scope for v1.

---

## Risks

| Risk | Mitigation |
|---|---|
| drive.file doesn't recurse into subfolders | Test before building. If true, list direct children only and document the limitation. |
| New files in picked folders not auto-accessible | Test before building. If true, consider periodic "are there new things?" prompts in UI. |
| Existing users churn during re-onboarding | Email in advance, make the new flow as fast as possible, explain why. |
| Picker API quota | Monitor; quota is generous for normal use. |
| Better Auth doesn't expose the access token easily | May need a custom server action or to store the token in a way the frontend can access via authenticated API. |
| Cleanup on folder removal is incomplete | Write thorough delete logic and a test for it before shipping. |
| Schema migration fails on Turso edge replicas | Use the same self-healing migration pattern from the OAuth tables work (see commit `0865182`). |

---

## Files that will need to change

Confirmed from the current codebase exploration:

- `www/src/auth/index.ts` — scope change
- `www/src/sync/google-drive.ts` — replace listGoogleDocs with picked-resource-aware version
- `www/src/sync/index.ts` — wire in picked resources
- `www/src/db/` — new `picked_resources` table + migration
- `www/src/components/` — new `GoogleDrivePicker.tsx`
- `www/src/app/` (or wherever routes live) — new onboarding route, new API routes for picked_resources
- `www/.env.example` — document `GOOGLE_PICKER_API_KEY` and `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`

Verify the actual file paths at migration time — the codebase may have moved.

---

## What to do first when picking this up

1. Read this file
2. Verify the open questions in the Picker playground (https://developers.google.com/drive/picker/guides/overview) before writing any code — these answers determine whether the whole plan is viable
3. Create the new Google Cloud project (Phase 0)
4. Cut the branch and set up Vercel preview + Turso branch DB (Phase 1)
5. Start with auth scope change + DB schema (smallest, lowest-risk changes first)
6. Build the picker component end-to-end with hardcoded fake state, prove it returns folder IDs
7. Wire it into the real flow
8. Test exhaustively per Phase 3 before even thinking about cutover

Good luck, future me.
