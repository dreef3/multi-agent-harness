# Repository Picker — Design Spec

## Goal

Simplify the repository adding dialog by replacing the multi-field form with a searchable picker. When a user selects a repository, all fields (name, cloneUrl, defaultBranch, provider-specific fields) are auto-populated from the API and locked.

## Problem Statement

Issue: dreef3/multi-agent-harness#7

Current state:
1. Repository adding dialog requires manual entry of 5+ fields
2. Not clear which fields are actually used
3. Free-text fields prone to typos and incorrect values

Desired state:
1. User selects a repository from a searchable picker (filtered by configured GitHub/Bitbucket token)
2. All fields auto-populate from the API response
3. Fields are read-only to prevent user error

---

## Architecture

### Data Flow

```
User clicks "Add Repository"
    ↓
Select provider (GitHub / Bitbucket Server)
    ↓
Picker fetches repos from /api/repositories/search?provider={provider}
    ↓
User searches and selects a repository
    ↓
All fields auto-populate (read-only)
    ↓
User clicks "Save"
    ↓
Repository stored in database
```

### Backend API

**New Endpoint: Search Available Repositories**

```
GET /api/repositories/search?provider={provider}
```

**Query Parameters:**
- `provider` (required): `"github"` or `"bitbucket-server"`

**Response:**
```json
{
  "repositories": [
    {
      "name": "my-repo",
      "cloneUrl": "https://github.com/org/my-repo.git",
      "defaultBranch": "main",
      "providerConfig": {
        "owner": "org",
        "repo": "my-repo"
      }
    }
  ]
}
```

**Error Responses:**
- `400`: Missing or invalid `provider` parameter
- `401`: Provider token not configured
- `503`: Failed to fetch repositories from provider API

**Implementation Details:**

| Provider | API Used | Filter |
|----------|----------|--------|
| github | `GET /user/repos` (Octokit) | `affiliation: owner,collaborator` |
| bitbucket-server | `GET /api/1.0/repositories/{workspace}` | User's workspaces |

For Bitbucket Server, we need to fetch the user's workspaces first, then list repos for each workspace.

### Repository Model (No Changes)

The existing `Repository` model is used unchanged:

```typescript
interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: {
    owner?: string;        // GitHub
    repo?: string;         // GitHub
    projectKey?: string;   // Bitbucket Server
    repoSlug?: string;     // Bitbucket Server
    baseUrl?: string;      // Bitbucket Server
  };
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## Frontend Changes

### New Component: RepositoryPicker

**File:** `frontend/src/components/RepositoryPicker.tsx`

A searchable dropdown that:
1. Fetches repositories from `/api/repositories/search?provider={provider}` on open
2. Shows loading state while fetching
3. Allows searching by repo name
4. On selection, calls `onSelect` callback with full repo data

**Props:**
```typescript
interface RepositoryPickerProps {
  provider: "github" | "bitbucket-server";
  value?: {
    name: string;
    cloneUrl: string;
    defaultBranch: string;
    providerConfig: Repository["providerConfig"];
  };
  onSelect: (repo: {
    name: string;
    cloneUrl: string;
    defaultBranch: string;
    providerConfig: Repository["providerConfig"];
  }) => void;
  disabled?: boolean;
}
```

**States:**
- `idle` — Initial state, picker not opened
- `loading` — Fetching repos from API
- `ready` — Repos loaded, showing dropdown
- `searching` — User is typing in search
- `empty` — No repos found or none accessible
- `error` — API error (token not configured, etc.)
- `selected` — Repo selected, showing summary

### Updated: RepositoryForm

**File:** `frontend/src/components/RepositoryForm.tsx`

Replaces the multi-field form with:

1. **Provider Selector** — Dropdown to select GitHub or Bitbucket Server
2. **Repository Picker** — Searchable dropdown (replaces owner/repo fields)
3. **Auto-populated Summary** — Read-only display of selected repo details
4. **Save/Cancel Buttons** — Unchanged

**Layout:**
```
┌─────────────────────────────────────────┐
│ Provider *                             │
│ [GitHub ▼]                             │
├─────────────────────────────────────────┤
│ Select Repository *                     │
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 Search repositories...           │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ Selected Repository:                   │
│ ┌─────────────────────────────────────┐ │
│ │ Name: my-repo                       │ │
│ │ Clone URL: ...git                   │ │
│ │ Default Branch: main                │ │
│ │ Owner: org / Repo: my-repo          │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ [Add Repository]  [Cancel]             │
└─────────────────────────────────────────┘
```

**Validation:**
- Provider must be selected
- Repository must be selected from picker
- All fields are auto-populated, no manual validation needed

### API Client

**File:** `frontend/src/lib/api.ts`

Add search endpoint:

```typescript
export async function searchRepositories(provider: "github" | "bitbucket-server"): Promise<{
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  providerConfig: Repository["providerConfig"];
}[]> {
  const response = await apiFetch(`/repositories/search?provider=${provider}`);
  return response.json();
}
```

---

## Backend Implementation

### New File: Search Repositories Endpoint

**File:** `backend/src/api/repositories.ts` (add to existing router)

```typescript
// Search available repositories for a provider
router.get("/search", async (req, res) => {
  const { provider } = req.query;
  
  if (!provider || !["github", "bitbucket-server"].includes(provider as string)) {
    res.status(400).json({ error: "Invalid or missing provider parameter" });
    return;
  }

  try {
    let repositories: any[] = [];

    if (provider === "github") {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        res.status(401).json({ error: "GitHub token not configured" });
        return;
      }
      repositories = await searchGitHubRepos(token);
    } else if (provider === "bitbucket-server") {
      const token = process.env.BITBUCKET_TOKEN;
      const baseUrl = process.env.BITBUCKET_BASE_URL;
      if (!token || !baseUrl) {
        res.status(401).json({ error: "Bitbucket credentials not configured" });
        return;
      }
      repositories = await searchBitbucketRepos(token, baseUrl);
    }

    res.json({ repositories });
  } catch (error) {
    console.error(`Failed to search ${provider} repos:`, error);
    res.status(503).json({ error: "Failed to fetch repositories" });
  }
});
```

### GitHub Search Implementation

**File:** `backend/src/connectors/github.ts` (add new method)

```typescript
export async function searchGitHubRepos(token: string): Promise<{
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  providerConfig: { owner: string; repo: string };
}[]> {
  const octokit = new Octokit({ auth: token });
  
  const { data: repos } = await octokit.repos.listForAuthenticatedUser({
    affiliation: "owner,collaborator",
    sort: "updated",
    per_page: 100,
  });

  return repos.map((repo) => ({
    name: repo.name,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch || "main",
    providerConfig: {
      owner: repo.owner.login,
      repo: repo.name,
    },
  }));
}
```

### Bitbucket Server Search Implementation

**File:** `backend/src/connectors/bitbucket.ts` (add new method)

```typescript
export async function searchBitbucketRepos(token: string, baseUrl: string): Promise<{
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  providerConfig: { baseUrl: string; projectKey: string; repoSlug: string };
}[]> {
  // 1. Get user's workspaces
  const workspacesResponse = await fetch(`${baseUrl}/api/1.0/workspaces`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const { values: workspaces } = await workspacesResponse.json();

  const repositories: any[] = [];

  // 2. For each workspace, fetch repos
  for (const workspace of workspaces.slice(0, 10)) { // Limit to first 10 workspaces
    const reposResponse = await fetch(
      `${baseUrl}/api/1.0/repositories/${workspace.slug}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );
    const { values: repos } = await reposResponse.json();

    for (const repo of repos || []) {
      repositories.push({
        name: repo.name,
        cloneUrl: repo.links.clone.find((l: any) => l.name === "https")?.href || repo.links.clone[0]?.href,
        defaultBranch: repo.mainbranch?.name || "main",
        providerConfig: {
          baseUrl,
          projectKey: workspace.key,
          repoSlug: repo.slug,
        },
      });
    }
  }

  return repositories;
}
```

---

## File Map

| File | Change Type | Description |
|------|-------------|-------------|
| `backend/src/api/repositories.ts` | Modify | Add `/search` endpoint |
| `backend/src/connectors/github.ts` | Modify | Add `searchGitHubRepos()` function |
| `backend/src/connectors/bitbucket.ts` | Modify | Add `searchBitbucketRepos()` function |
| `frontend/src/components/RepositoryPicker.tsx` | New | Searchable picker component |
| `frontend/src/components/RepositoryForm.tsx` | Modify | Replace multi-field form with picker |
| `frontend/src/lib/api.ts` | Modify | Add `searchRepositories()` API function |
| `backend/src/__tests__/repositories.test.ts` | New | Test search endpoint |
| `frontend/src/__tests__/RepositoryPicker.test.tsx` | New | Test picker component |

---

## Testing Strategy

### Backend Tests

1. **Search endpoint returns GitHub repos** — Mock Octokit, verify correct response format
2. **Search endpoint returns Bitbucket repos** — Mock fetch, verify correct response format
3. **Returns 401 when token not configured** — Test for GitHub and Bitbucket
4. **Returns 400 for invalid provider** — Test with empty/whitespace/wrong value

### Frontend Tests

1. **Picker fetches repos on provider change** — Mock API, verify fetch is called
2. **Picker shows loading state** — Verify spinner while fetching
3. **Picker allows searching** — Type in search box, verify filtered results
4. **Selection populates form** — Select repo, verify all fields auto-populate
5. **Form is locked after selection** — Verify fields are read-only

### Integration Tests

1. **Full add repository flow** — Select provider → pick repo → save → verify in list
2. **Edit repository** — Click edit on existing repo, verify picker shows selected repo

---

## Rollout Plan

1. **Backend:** Add search endpoint and connector methods (low risk, additive)
2. **Frontend:** Create `RepositoryPicker` component
3. **Frontend:** Update `RepositoryForm` to use picker
4. **Frontend:** Add API client method
5. **Tests:** Add backend and frontend tests
6. **E2E:** Update existing E2E tests if needed

---

## Security Considerations

- **Token Scope:** `GITHUB_TOKEN` needs `repo` scope and `read:user` for listing user repos
- **Bitbucket Scope:** `BITBUCKET_TOKEN` needs `repository` read access
- **No new secrets:** Credentials already exist in environment variables
- **Rate Limiting:** GitHub API has rate limits; implement caching if needed (out of scope for MVP)

---

## Out of Scope

- Repository caching (future enhancement)
- Pagination in picker (MVP: show first 100 repos)
- Custom clone URL override
- Repository filtering by organization/workspace selection
