# Simplified Repository Adding Dialog Implementation Plan

> **For agentic workers:** Tasks will be executed by containerised sub-agents.
> Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.

**Goal:** Replace the multi-field repository form with a picker that auto-fills all fields from GitHub API.

**Architecture:** 
- New `GET /api/repositories/available` endpoint returns GitHub repos not yet configured
- Frontend picker calls this endpoint and allows selection of available repos
- On selection, repo data is auto-filled and POSTed to existing `/api/repositories`

**Tech Stack:** TypeScript (backend), React + TypeScript (frontend), Vitest (testing), Express, Octokit

---

## File Structure

```
src/
├── api/
│   └── repositories.ts        # Modify: add GET /available endpoint
├── connectors/
│   └── github.ts             # Modify: add listAccessibleRepositories()
└── store/
    └── repositories.ts       # Modify: add getConfiguredCloneUrls()

frontend/src/
├── components/
│   ├── RepositoryPicker.tsx  # Create: picker component
│   └── AddRepositoryDialog.tsx # Create: dialog component
└── hooks/
    └── useAvailableRepositories.ts # Create: data fetching hook

__tests__/
└── repositories.test.ts      # Create: backend tests
```

---

## Backend Tasks

### Task 1: Add `getConfiguredCloneUrls()` to store

**Files:**
- Modify: `src/store/repositories.ts`
- Test: `__tests__/repositories.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// __tests__/repositories.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getConfiguredCloneUrls } from "../store/repositories.js";

describe("getConfiguredCloneUrls", () => {
  it("returns array of cloneUrls for all configured repositories", async () => {
    const urls = getConfiguredCloneUrls();
    expect(Array.isArray(urls)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- __tests__/repositories.test.ts`
Expected: FAIL with "getConfiguredCloneUrls is not a function"

- [ ] **Step 3: Add getConfiguredCloneUrls to store/repositories.ts**

Add after the existing exports:

```typescript
export function getConfiguredCloneUrls(): string[] {
  const rows = getDb()
    .prepare("SELECT clone_url FROM repositories")
    .all();
  return rows.map(row => row.clone_url);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- __tests__/repositories.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/repositories.ts __tests__/repositories.test.ts
git commit -m "feat: add getConfiguredCloneUrls helper for filtering available repos"
```

---

### Task 2: Add `listAccessibleRepositories()` to GitHub connector

**Files:**
- Modify: `src/connectors/github.ts`
- Test: `__tests__/connectors.test.ts`

- [ ] **Step 1: Write failing test**

Add to `__tests__/connectors.test.ts`:

```typescript
describe("listAccessibleRepositories", () => {
  const mockListForUser = vi.fn();
  
  beforeEach(() => {
    // Override the mock for this test
    vi.mocked(Octokit).mockImplementation(() => ({
      repos: {
        listForUser: mockListForUser,
      },
    }));
  });

  it("returns repositories with cloneUrl, name, owner, defaultBranch", async () => {
    mockListForUser.mockResolvedValue({
      data: [
        {
          name: "my-repo",
          owner: { login: "testuser" },
          default_branch: "main",
          clone_url: "https://github.com/testuser/my-repo.git",
        },
      ],
    });

    const repos = await connector.listAccessibleRepositories();
    
    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual({
      cloneUrl: "https://github.com/testuser/my-repo.git",
      name: "my-repo",
      owner: "testuser",
      defaultBranch: "main",
    });
  });

  it("handles pagination and returns all repos", async () => {
    mockListForUser
      .mockResolvedValueOnce({
        data: [
          { name: "repo-1", owner: { login: "user" }, default_branch: "main", clone_url: "url1" },
        ],
      })
      .mockResolvedValueOnce({
        data: [],
      });

    const repos = await connector.listAccessibleRepositories();
    
    expect(repos).toHaveLength(1);
    expect(mockListForUser).toHaveBeenCalledTimes(2);
  });

  it("throws ConnectorError when token is missing", async () => {
    process.env.GITHUB_TOKEN = "";
    connector = new GitHubConnector();
    
    await expect(connector.listAccessibleRepositories())
      .rejects.toThrow(ConnectorError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- __tests__/connectors.test.ts -t "listAccessibleRepositories"`
Expected: FAIL with "connector.listAccessibleRepositories is not a function"

- [ ] **Step 3: Add method to GitHubConnector**

Add to `src/connectors/github.ts`:

```typescript
async listAccessibleRepositories(): Promise<Array<{
  cloneUrl: string;
  name: string;
  owner: string;
  defaultBranch: string;
}>> {
  const octokit = this.getOctokit();
  const repos: Array<{
    cloneUrl: string;
    name: string;
    owner: string;
    defaultBranch: string;
  }> = [];
  
  try {
    let page = 1;
    const perPage = 100;
    
    while (true) {
      const { data } = await octokit.repos.listForAuthenticatedUser({
        per_page: perPage,
        page,
        sort: "updated",
        direction: "desc",
      });
      
      if (data.length === 0) break;
      
      for (const repo of data) {
        repos.push({
          cloneUrl: repo.clone_url,
          name: repo.name,
          owner: repo.owner.login,
          defaultBranch: repo.default_branch,
        });
      }
      
      if (data.length < perPage) break;
      page++;
    }
    
    return repos;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(
      `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`,
      "github",
      error
    );
  }
}
```

Also update the VcsConnector interface in `src/connectors/types.ts` to add the method signature:

```typescript
export interface VcsConnector {
  listAccessibleRepositories(): Promise<Array<{
    cloneUrl: string;
    name: string;
    owner: string;
    defaultBranch: string;
  }>>;
  // ... existing methods
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- __tests__/connectors.test.ts -t "listAccessibleRepositories"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/connectors/github.ts src/connectors/types.ts __tests__/connectors.test.ts
git commit -m "feat: add listAccessibleRepositories to GitHub connector"
```

---

### Task 3: Add `GET /api/repositories/available` endpoint

**Files:**
- Modify: `src/api/repositories.ts`
- Test: `__tests__/repositories.test.ts`

- [ ] **Step 1: Write failing test**

Add to `__tests__/repositories.test.ts`:

```typescript
describe("GET /repositories/available", () => {
  it("returns available repos not in database", async () => {
    // Mock the GitHub connector
    const mockConnector = {
      listAccessibleRepositories: vi.fn().mockResolvedValue([
        { cloneUrl: "https://github.com/user/repo1", name: "repo1", owner: "user", defaultBranch: "main" },
        { cloneUrl: "https://github.com/user/repo2", name: "repo2", owner: "user", defaultBranch: "main" },
      ]),
    };
    vi.mocked(getConnector).mockReturnValue(mockConnector as any);

    const response = await request(app)
      .get("/repositories/available")
      .expect(200);

    expect(response.body.repositories).toHaveLength(2);
    expect(response.body.repositories[0]).toMatchObject({
      cloneUrl: "https://github.com/user/repo1",
      name: "repo1",
      owner: "user",
      defaultBranch: "main",
    });
  });

  it("filters out already configured repos", async () => {
    // First add a repo to the database
    const mockConnector = {
      listAccessibleRepositories: vi.fn().mockResolvedValue([
        { cloneUrl: "https://github.com/user/repo1", name: "repo1", owner: "user", defaultBranch: "main" },
        { cloneUrl: "https://github.com/user/repo2", name: "repo2", owner: "user", defaultBranch: "main" },
      ]),
    };
    vi.mocked(getConnector).mockReturnValue(mockConnector as any);

    await request(app)
      .post("/repositories")
      .send({
        name: "repo1",
        cloneUrl: "https://github.com/user/repo1",
        provider: "github",
        providerConfig: { owner: "user", repo: "repo1" },
        defaultBranch: "main",
      });

    const response = await request(app)
      .get("/repositories/available")
      .expect(200);

    expect(response.body.repositories).toHaveLength(1);
    expect(response.body.repositories[0].name).toBe("repo2");
  });

  it("returns 401 when GitHub token is missing", async () => {
    const mockConnector = {
      listAccessibleRepositories: vi.fn().mockRejectedValue(
        new ConnectorError("GITHUB_TOKEN environment variable not set", "github")
      ),
    };
    vi.mocked(getConnector).mockReturnValue(mockConnector as any);

    const response = await request(app)
      .get("/repositories/available")
      .expect(401);

    expect(response.body.error).toBe("GitHub token not configured or invalid");
  });

  it("returns 502 when GitHub API fails", async () => {
    const mockConnector = {
      listAccessibleRepositories: vi.fn().mockRejectedValue(
        new Error("API rate limit exceeded")
      ),
    };
    vi.mocked(getConnector).mockReturnValue(mockConnector as any);

    const response = await request(app)
      .get("/repositories/available")
      .expect(502);

    expect(response.body.error).toBe("Failed to fetch repositories from GitHub");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- __tests__/repositories.test.ts -t "available"`
Expected: FAIL (route doesn't exist)

- [ ] **Step 3: Add GET /available route to repositories.ts**

Add to `src/api/repositories.ts`:

```typescript
import { getConnector } from "../connectors/types.js";
import { getConfiguredCloneUrls } from "../store/repositories.js";

// Add to createRepositoriesRouter():
router.get("/available", async (req, res) => {
  try {
    const connector = getConnector("github");
    
    const availableRepos = await connector.listAccessibleRepositories();
    const configuredUrls = getConfiguredCloneUrls();
    
    const filteredRepos = availableRepos.filter(
      repo => !configuredUrls.includes(repo.cloneUrl)
    );
    
    res.json({ repositories: filteredRepos });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    if (message.includes("not set") || message.includes("not configured")) {
      res.status(401).json({ error: "GitHub token not configured or invalid" });
      return;
    }
    
    res.status(502).json({ error: "Failed to fetch repositories from GitHub" });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- __tests__/repositories.test.ts -t "available"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/repositories.ts __tests__/repositories.test.ts
git commit -m "feat: add GET /repositories/available endpoint"
```

---

## Frontend Tasks

### Task 4: Create `useAvailableRepositories` hook

**Files:**
- Create: `frontend/src/hooks/useAvailableRepositories.ts`

- [ ] **Step 1: Create the hook**

```typescript
// frontend/src/hooks/useAvailableRepositories.ts
import { useState, useEffect, useCallback } from "react";

export interface AvailableRepository {
  cloneUrl: string;
  name: string;
  owner: string;
  defaultBranch: string;
}

interface UseAvailableRepositoriesResult {
  data: AvailableRepository[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAvailableRepositories(): UseAvailableRepositoriesResult {
  const [data, setData] = useState<AvailableRepository[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    
    async function fetchRepos() {
      setIsLoading(true);
      setError(null);
      
      try {
        const response = await fetch("/api/repositories/available");
        
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        
        if (!cancelled) {
          setData(result.repositories);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setIsLoading(false);
        }
      }
    }
    
    fetchRepos();
    
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return { data, isLoading, error, refetch };
}
```

- [ ] **Step 2: Export from hooks index**

If `frontend/src/hooks/index.ts` exists, add:

```typescript
export { useAvailableRepositories } from "./useAvailableRepositories";
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useAvailableRepositories.ts
git commit -m "feat: add useAvailableRepositories hook"
```

---

### Task 5: Create `RepositoryPicker` component

**Files:**
- Create: `frontend/src/components/RepositoryPicker.tsx`

- [ ] **Step 1: Create the component**

```typescript
// frontend/src/components/RepositoryPicker.tsx
import React, { useState } from "react";
import { useAvailableRepositories, AvailableRepository } from "../hooks/useAvailableRepositories";

interface RepositoryPickerProps {
  onSelect: (repo: AvailableRepository) => void;
  disabled?: boolean;
}

export function RepositoryPicker({ onSelect, disabled = false }: RepositoryPickerProps) {
  const { data, isLoading, error, refetch } = useAvailableRepositories();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<AvailableRepository | null>(null);

  const filteredRepos = data?.filter(
    repo =>
      repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      repo.owner.toLowerCase().includes(searchQuery.toLowerCase())
  ) ?? [];

  const handleSelect = (repo: AvailableRepository) => {
    setSelectedRepo(repo);
    onSelect(repo);
  };

  if (isLoading) {
    return (
      <div className="repository-picker loading">
        <div className="spinner" />
        <span>Loading repositories...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="repository-picker error">
        <p className="error-message">Failed to load repositories. Check your GitHub token configuration.</p>
        <button onClick={refetch} disabled={disabled}>
          Retry
        </button>
      </div>
    );
  }

  if (filteredRepos.length === 0) {
    return (
      <div className="repository-picker empty">
        <p>No available repositories found</p>
      </div>
    );
  }

  return (
    <div className="repository-picker">
      <input
        type="text"
        placeholder="Search repositories..."
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        disabled={disabled}
        className="search-input"
      />
      
      <ul className="repo-list">
        {filteredRepos.map(repo => (
          <li
            key={repo.cloneUrl}
            className={`repo-item ${selectedRepo?.cloneUrl === repo.cloneUrl ? "selected" : ""}`}
          >
            <button
              onClick={() => handleSelect(repo)}
              disabled={disabled}
              className="repo-button"
            >
              <span className="repo-name">{repo.name}</span>
              <span className="repo-owner">{repo.owner}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Add basic styles (if styled-components or CSS modules used)**

Add to appropriate stylesheet:

```css
.repository-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.repository-picker .search-input {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.repository-picker .repo-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.repository-picker .repo-item {
  border-bottom: 1px solid #eee;
}

.repository-picker .repo-item:last-child {
  border-bottom: none;
}

.repository-picker .repo-button {
  width: 100%;
  padding: 12px;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
}

.repository-picker .repo-button:hover:not(:disabled) {
  background: #f5f5f5;
}

.repository-picker .repo-item.selected .repo-button {
  background: #e3f2fd;
}

.repository-picker .spinner {
  width: 20px;
  height: 20px;
  border: 2px solid #ddd;
  border-top-color: #666;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/RepositoryPicker.tsx
git commit -m "feat: add RepositoryPicker component"
```

---

### Task 6: Create `AddRepositoryDialog` component

**Files:**
- Create: `frontend/src/components/AddRepositoryDialog.tsx`

- [ ] **Step 1: Create the dialog component**

```typescript
// frontend/src/components/AddRepositoryDialog.tsx
import React, { useState } from "react";
import { RepositoryPicker, AvailableRepository } from "./RepositoryPicker";

interface AddRepositoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function AddRepositoryDialog({ isOpen, onClose, onSuccess }: AddRepositoryDialogProps) {
  const [selectedRepo, setSelectedRepo] = useState<AvailableRepository | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSelect = (repo: AvailableRepository) => {
    setSelectedRepo(repo);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!selectedRepo) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: selectedRepo.name,
          cloneUrl: selectedRepo.cloneUrl,
          provider: "github",
          providerConfig: {
            owner: selectedRepo.owner,
            repo: selectedRepo.name,
          },
          defaultBranch: selectedRepo.defaultBranch,
        }),
      });

      if (response.status === 409) {
        setError("Repository already configured");
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      setSelectedRepo(null);
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add repository");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setSelectedRepo(null);
    setError(null);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div className="dialog-content" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>Add Repository</h2>
          <button className="close-button" onClick={handleClose}>×</button>
        </div>

        <div className="dialog-body">
          <RepositoryPicker onSelect={handleSelect} disabled={isSubmitting} />

          {selectedRepo && (
            <div className="selected-repo">
              <span>Selected: </span>
              <strong>{selectedRepo.owner}/{selectedRepo.name}</strong>
              <span> ({selectedRepo.defaultBranch} branch)</span>
            </div>
          )}

          {error && (
            <div className="error-message">{error}</div>
          )}
        </div>

        <div className="dialog-footer">
          <button onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!selectedRepo || isSubmitting}
            className="primary"
          >
            {isSubmitting ? "Adding..." : "Add Repository"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add dialog styles**

```css
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog-content {
  background: white;
  border-radius: 8px;
  width: 100%;
  max-width: 500px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #eee;
}

.dialog-header h2 {
  margin: 0;
  font-size: 18px;
}

.dialog-body {
  padding: 20px;
  overflow-y: auto;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #eee;
}

.dialog-footer button {
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}

.dialog-footer button.primary {
  background: #0066cc;
  color: white;
  border: none;
}

.dialog-footer button.primary:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.selected-repo {
  margin-top: 16px;
  padding: 12px;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 14px;
}
```

- [ ] **Step 3: Export from components index**

If `frontend/src/components/index.ts` exists, add:

```typescript
export { AddRepositoryDialog } from "./AddRepositoryDialog";
export { RepositoryPicker } from "./RepositoryPicker";
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AddRepositoryDialog.tsx
git commit -m "feat: add AddRepositoryDialog component"
```

---

## Final Integration Task

### Task 7: Wire up AddRepositoryDialog in the app

**Files:**
- Modify: `frontend/src/App.tsx` (or wherever repositories are managed)

- [ ] **Step 1: Add dialog trigger and state**

In the component that manages repositories:

```typescript
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";

function RepositoriesPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleSuccess = () => {
    // Refresh the repository list
    // This depends on how the app manages state - could be refetch, context update, etc.
  };

  return (
    <>
      <button onClick={() => setIsDialogOpen(true)}>
        Add Repository
      </button>
      
      <AddRepositoryDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onSuccess={handleSuccess}
      />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: wire up AddRepositoryDialog in app"
```

---

## Running the Implementation

After all tasks are complete:

1. Run all backend tests:
   ```bash
   npm test
   ```

2. Build the backend:
   ```bash
   npm run build
   ```

3. Verify frontend compiles (if TypeScript):
   ```bash
   cd frontend && npx tsc --noEmit
   ```
