# Spec: Simplified Repository Adding Dialog

## Context

**Issue:** [dreef3/multi-agent-harness#7](https://github.com/dreef3/multi-agent-harness/issues/7) — Repository adding dialog is overloaded

**Problems:**
1. It should be possible to deduce all other fields from just a link
2. Not clear if all the fields are even really used
3. Must be a picker of repositories available via configured GitHub token, not free text field

**Current state:** Adding a repository requires manually filling out:
- `name` (free text)
- `cloneUrl` (free text - URL format)
- `provider` (free text - "github", "bitbucket-server")
- `providerConfig` (JSON with `owner` and `repo`)
- `defaultBranch` (free text, defaults to "main")

This is error-prone and requires users to know GitHub URL formats.

---

## Solution

Replace the multi-field form with a simple repository picker that auto-fills all necessary data.

---

## Design

### User Experience

**Add Repository Dialog Flow:**

1. User clicks "Add Repository"
2. Dialog opens, immediately fetches `GET /api/repositories/available`
3. While loading: show spinner with "Loading repositories..."
4. On success: show searchable picker list
5. On error: show error message with retry button:
   - "Failed to load repositories. Check your GitHub token configuration."
   - [Retry] button → re-fetches the endpoint
6. User selects a repo → repo details shown as read-only confirmation:
   - "Selected: owner/repo (main branch)"
7. User clicks "Add" → POST to `/api/repositories` with auto-filled data
8. On success: close dialog, show success toast
9. If repo was already added (race condition): show "Repository already configured" error

---

### API: New Endpoint

**`GET /api/repositories/available`**

Returns repositories from the GitHub account that are NOT already configured in the harness.

**Request:** No parameters required.

**Response (200 OK):**
```json
{
  "repositories": [
    {
      "cloneUrl": "https://github.com/dreef3/my-repo",
      "name": "my-repo",
      "owner": "dreef3",
      "defaultBranch": "main"
    }
  ]
}
```

**Error (502 Bad Gateway):** GitHub API unavailable
```json
{
  "error": "Failed to fetch repositories from GitHub"
}
```

**Error (401 Unauthorized):** Invalid or missing GitHub token
```json
{
  "error": "GitHub token not configured or invalid"
}
```

**Behavior:**
- Requires valid `GITHUB_TOKEN` environment variable
- Returns only repos NOT already in the harness database
- Fetches repos via GitHub API (paginated, handles 100+ repos)
- Sort by most recently updated

---

### API: Modified Create Repository

**`POST /api/repositories`** accepts the same payload as before — no changes needed to the endpoint itself.

The frontend will now send a fully populated object:
```json
{
  "name": "my-repo",
  "cloneUrl": "https://github.com/dreef3/my-repo",
  "provider": "github",
  "providerConfig": { "owner": "dreef3", "repo": "my-repo" },
  "defaultBranch": "main"
}
```

---

### Data Model

**Repository model (unchanged):**
```json
{
  "id": "uuid",
  "name": "string",
  "cloneUrl": "string",
  "provider": "github | bitbucket-server",
  "providerConfig": { "owner": "string", "repo": "string" },
  "defaultBranch": "string",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

No changes to stored schema. The simplification is at the input layer.

---

### Backend Implementation

**New files:**

1. **`src/api/repositories.ts`** — Add `GET /repositories/available` endpoint
2. **`src/connectors/github.ts`** — Add `listAccessibleRepositories()` method
3. **`src/store/repositories.ts`** — Add `getConfiguredCloneUrls()` helper

**Logic in `GET /repositories/available`:**
```
1. Call GitHub API: list all repos for authenticated user (paginated)
2. Call local DB: get all configured cloneUrls
3. Filter: exclude any repo whose cloneUrl is already configured
4. Return: { repositories: [{ cloneUrl, name, owner, defaultBranch }] }
```

**Deducible fields (from GitHub API response):**
- `name`: `repo.name`
- `owner`: `repo.owner.login`
- `defaultBranch`: `repo.default_branch`
- `cloneUrl`: constructed as `https://github.com/{owner}/{repo}`

---

### Error Handling

| Scenario | API Response | UI Behavior |
|----------|--------------|-------------|
| GitHub API failure | 502 with error message | Error state with Retry button |
| Invalid/missing token | 401 with error message | Error state with "Check token config" message |
| Repo already configured | 409 on POST | "Repository already configured" toast |
| Network error | 503 with error message | Error state with Retry button |

---

## Files to Modify/Create

### Backend Files
- `src/api/repositories.ts` — New endpoint `GET /repositories/available`
- `src/connectors/github.ts` — `listAccessibleRepositories()` method
- `src/store/repositories.ts` — `getConfiguredCloneUrls()` helper

### Frontend Files
- `frontend/src/components/RepositoryPicker.tsx` — New picker component
- `frontend/src/components/AddRepositoryDialog.tsx` — New dialog component (or modify existing)
- `frontend/src/hooks/useAvailableRepositories.ts` — Hook to fetch and cache available repos

### Tests
- `__tests__/repositories.test.ts` — Test the new endpoint with mocked GitHub API

---

## Frontend Implementation

### RepositoryPicker Component

```tsx
interface RepositoryPickerProps {
  onSelect: (repo: AvailableRepository) => void;
  disabled?: boolean;
}

interface AvailableRepository {
  cloneUrl: string;
  name: string;
  owner: string;
  defaultBranch: string;
}

// States:
// - loading: Shows spinner "Loading repositories..."
// - error: Shows error message with "Retry" button
// - empty: Shows "No available repositories found"
// - success: Shows searchable list of repos
// - selected: Shows "Selected: owner/repo (main branch)" confirmation
```

### useAvailableRepositories Hook

```tsx
function useAvailableRepositories() {
  // Fetches GET /api/repositories/available on mount
  // Returns: { data, isLoading, error, refetch }
  // Refetch function triggers retry on error
}
```

### AddRepositoryDialog Component

- Opens RepositoryPicker on mount (auto-fetches available repos)
- Shows selected repo confirmation before enabling "Add" button
- Calls POST /api/repositories with auto-filled data on submit
- Handles success (close dialog) and error (show toast) states

---

## Out of Scope

- Adding Bitbucket support for the picker (only GitHub picker initially)
- Editing repository details via picker
- Bulk operations on repositories
