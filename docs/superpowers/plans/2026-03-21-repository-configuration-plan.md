# Repository Configuration for Projects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repository configuration UI to Settings page, repository multi-select to NewProject page, and an E2E test that creates a project, runs through brainstorm/plan/approve flow, and verifies PR creation.

**Architecture:** Backend already has complete repository CRUD API. Add a settings endpoint to return provider credential status. Frontend adds repository management to Settings page and repository selection to NewProject page. E2E test covers full flow.

**Tech Stack:** React, TypeScript, Express, Playwright, SQLite

---

## File Map

| File | Responsibility |
|------|-----------------|
| `backend/src/api/settings.ts` | New file: provider status endpoint |
| `backend/src/api/routes.ts` | Mount settings router |
| `frontend/src/lib/api.ts` | Add Repository interface and API methods |
| `frontend/src/pages/Settings.tsx` | Add Repositories section with CRUD UI |
| `frontend/src/components/RepositoryForm.tsx` | New file: repository form modal |
| `frontend/src/pages/NewProject.tsx` | Add repository multi-select |
| `e2e-tests/tests/repository-flow.spec.ts` | New file: E2E test for full flow |
| `e2e-tests/package.json` | Add test dependencies |

---

### Task 1: Backend Settings Endpoint

**Files:**
- Create: `backend/src/api/settings.ts`
- Modify: `backend/src/api/routes.ts`

- [ ] **Step 1: Write settings endpoint**

Create `backend/src/api/settings.ts`:

```typescript
import { Router } from "express";

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/providers", (_req, res) => {
    const githubToken = process.env.GITHUB_TOKEN;
    const bitbucketToken = process.env.BITBUCKET_TOKEN;
    const bitbucketBaseUrl = process.env.BITBUCKET_BASE_URL;

    res.json({
      providers: [
        {
          name: "github",
          configured: !!githubToken,
        },
        {
          name: "bitbucket-server",
          configured: !!(bitbucketToken && bitbucketBaseUrl),
        },
      ],
    });
  });

  return router;
}
```

- [ ] **Step 2: Wire settings router into routes**

Modify `backend/src/api/routes.ts` to import and mount the settings router:

```typescript
import { createSettingsRouter } from "./settings.js";

// ... existing imports ...

export function createRouter(dataDir: string, docker: Dockerode): Router {
  const router = Router();

  // ... existing routes ...

  router.use("/settings", createSettingsRouter());

  return router;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Test the endpoint manually**

Run: `cd backend && npm run dev`
Then: `curl http://localhost:3000/api/settings/providers`
Expected: JSON with providers array

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/settings.ts backend/src/api/routes.ts
git commit -m "feat(settings): add provider status endpoint"
```

---

### Task 2: Frontend API Client — Repository Types

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Add Repository interface and API methods**

Modify `frontend/src/lib/api.ts` to add:

```typescript
export interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: {
    owner?: string;
    repo?: string;
    projectKey?: string;
    repoSlug?: string;
    baseUrl?: string;
  };
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderStatus {
  name: "github" | "bitbucket-server";
  configured: boolean;
}

export interface SettingsInfo {
  providers: ProviderStatus[];
}
```

- [ ] **Step 2: Update repositories API methods**

Replace the `repositories` object in the `api` object:

```typescript
  repositories: {
    list: () => fetchJson<Repository[]>(`${API_BASE}/repositories`),
    get: (id: string) => fetchJson<Repository>(`${API_BASE}/repositories/${id}`),
    create: (data: Omit<Repository, "id" | "createdAt" | "updatedAt">) =>
      fetchJson<Repository>(`${API_BASE}/repositories`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Omit<Repository, "id" | "createdAt" | "updatedAt">>) =>
      fetchJson<Repository>(`${API_BASE}/repositories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetch(`${API_BASE}/repositories/${id}`, { method: "DELETE" }),
  },
  settings: {
    providers: () => fetchJson<SettingsInfo>(`${API_BASE}/settings/providers`),
  },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(frontend): add Repository and Settings types to API client"
```

---

### Task 3: Repository Form Component

**Files:**
- Create: `frontend/src/components/RepositoryForm.tsx`

- [ ] **Step 1: Create repository form component**

Create `frontend/src/components/RepositoryForm.tsx`:

```typescript
import { useState } from "react";
import type { Repository } from "../lib/api";

interface RepositoryFormProps {
  repository?: Repository;
  onSubmit: (data: Omit<Repository, "id" | "createdAt" | "updatedAt">) => void;
  onCancel: () => void;
}

export default function RepositoryForm({ repository, onSubmit, onCancel }: RepositoryFormProps) {
  const [name, setName] = useState(repository?.name ?? "");
  const [provider, setProvider] = useState<"github" | "bitbucket-server">(
    repository?.provider ?? "github"
  );
  const [cloneUrl, setCloneUrl] = useState(repository?.cloneUrl ?? "");
  const [defaultBranch, setDefaultBranch] = useState(repository?.defaultBranch ?? "main");

  const [owner, setOwner] = useState(repository?.providerConfig?.owner ?? "");
  const [repoName, setRepoName] = useState(repository?.providerConfig?.repo ?? "");

  const [baseUrl, setBaseUrl] = useState(repository?.providerConfig?.baseUrl ?? "");
  const [projectKey, setProjectKey] = useState(repository?.providerConfig?.projectKey ?? "");
  const [repoSlug, setRepoSlug] = useState(repository?.providerConfig?.repoSlug ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const providerConfig = provider === "github"
      ? { owner, repo: repoName }
      : { baseUrl, projectKey, repoSlug };

    onSubmit({
      name,
      cloneUrl,
      provider,
      providerConfig,
      defaultBranch,
    });
  };

  const isGitHub = provider === "github";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Display Name *
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Repository"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Provider *
        </label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as "github" | "bitbucket-server")}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
        >
          <option value="github">GitHub</option>
          <option value="bitbucket-server">Bitbucket Server</option>
        </select>
      </div>

      {isGitHub ? (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Owner *
            </label>
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="org-name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repository Name *
            </label>
            <input
              type="text"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="repo-name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Base URL *
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://bitbucket.company.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Project Key *
            </label>
            <input
              type="text"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              placeholder="PROJ"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repository Slug *
            </label>
            <input
              type="text"
              value={repoSlug}
              onChange={(e) => setRepoSlug(e.target.value)}
              placeholder="repo-slug"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
        </>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Clone URL *
        </label>
        <input
          type="url"
          value={cloneUrl}
          onChange={(e) => setCloneUrl(e.target.value)}
          placeholder="https://github.com/org/repo.git"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Default Branch
        </label>
        <input
          type="text"
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="main"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={!name || !cloneUrl || (isGitHub ? !owner || !repoName : !baseUrl || !projectKey || !repoSlug)}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-4 py-2 rounded-lg font-medium"
        >
          {repository ? "Update" : "Add"} Repository
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-medium"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/RepositoryForm.tsx
git commit -m "feat(frontend): repository form component"
```

---

### Task 4: Settings Page — Repositories Section

**Files:**
- Modify: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Add repositories section to Settings page**

Modify `frontend/src/pages/Settings.tsx` to add repository management. Add imports and state for repositories:

```typescript
import { useEffect, useState } from "react";
import { api, Config, ModelConfig, Repository } from "../lib/api";
import RepositoryForm from "../components/RepositoryForm";

// ... inside Settings component, add state:
const [repositories, setRepositories] = useState<Repository[]>([]);
const [showRepoForm, setShowRepoForm] = useState(false);
const [editingRepo, setEditingRepo] = useState<Repository | null>(null);
const [repoLoading, setRepoLoading] = useState(false);
const [repoError, setRepoError] = useState<string | null>(null);
```

- [ ] **Step 2: Add repository loading and CRUD functions**

Add after the existing useEffect:

```typescript
  useEffect(() => {
    loadRepositories();
  }, []);

  async function loadRepositories() {
    try {
      setRepoLoading(true);
      const repos = await api.repositories.list();
      setRepositories(repos);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to load repositories");
    } finally {
      setRepoLoading(false);
    }
  }

  async function handleCreateRepo(data: Omit<Repository, "id" | "createdAt" | "updatedAt">) {
    try {
      const newRepo = await api.repositories.create(data);
      setRepositories((prev) => [newRepo, ...prev]);
      setShowRepoForm(false);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to create repository");
    }
  }

  async function handleUpdateRepo(id: string, data: Partial<Repository>) {
    try {
      const updated = await api.repositories.update(id, data);
      setRepositories((prev) => prev.map((r) => (r.id === id ? updated : r)));
      setEditingRepo(null);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to update repository");
    }
  }

  async function handleDeleteRepo(id: string) {
    if (!confirm("Are you sure you want to delete this repository?")) return;
    try {
      await api.repositories.delete(id);
      setRepositories((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to delete repository");
    }
  }
```

- [ ] **Step 3: Add repositories UI section**

Add after the Worker Agents section, before the Save button:

```tsx
      {repoError && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded-lg">
          {repoError}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Repositories</h2>
          <button
            onClick={() => setShowRepoForm(true)}
            className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-sm font-medium"
          >
            + Add Repository
          </button>
        </div>

        {repoLoading ? (
          <div className="text-gray-400">Loading repositories...</div>
        ) : repositories.length === 0 ? (
          <div className="text-gray-400">No repositories configured. Add one to get started.</div>
        ) : (
          <div className="space-y-2">
            {repositories.map((repo) => (
              <div
                key={repo.id}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex items-center justify-between"
              >
                <div>
                  <div className="font-medium">{repo.name}</div>
                  <div className="text-sm text-gray-400">{repo.cloneUrl}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    <span
                      className={`inline-block px-2 py-0.5 rounded ${
                        repo.provider === "github"
                          ? "bg-gray-700 text-gray-300"
                          : "bg-blue-900 text-blue-300"
                      }`}
                    >
                      {repo.provider === "github" ? "GitHub" : "Bitbucket Server"}
                    </span>
                    {repo.provider === "github" && (
                      <span className="ml-2">
                        {repo.providerConfig?.owner}/{repo.providerConfig?.repo}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditingRepo(repo)}
                    className="text-gray-400 hover:text-white px-3 py-1"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteRepo(repo.id)}
                    className="text-red-400 hover:text-red-300 px-3 py-1"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showRepoForm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
              <h3 className="text-lg font-semibold mb-4">Add Repository</h3>
              <RepositoryForm
                onSubmit={handleCreateRepo}
                onCancel={() => setShowRepoForm(false)}
              />
            </div>
          </div>
        )}

        {editingRepo && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
              <h3 className="text-lg font-semibold mb-4">Edit Repository</h3>
              <RepositoryForm
                repository={editingRepo}
                onSubmit={(data) => handleUpdateRepo(editingRepo.id, data)}
                onCancel={() => setEditingRepo(null)}
              />
            </div>
          </div>
        )}

        <p className="text-xs text-gray-500">
          Credentials are configured via environment variables (GITHUB_TOKEN for GitHub,
          BITBUCKET_TOKEN and BITBUCKET_BASE_URL for Bitbucket Server).
        </p>
      </div>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Test manually**

Run: `cd backend && npm run dev` and `cd frontend && npm run dev`
Navigate to Settings page, verify repository CRUD works.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Settings.tsx
git commit -m "feat(frontend): add repositories section to Settings page"
```

---

### Task 5: NewProject Page — Repository Selection

**Files:**
- Modify: `frontend/src/pages/NewProject.tsx`

- [ ] **Step 1: Add repository state and loading**

Modify `frontend/src/pages/NewProject.tsx` to add repository selection. Add imports and state:

```typescript
import { api, Repository } from "../lib/api";

// ... inside NewProject component, add state:
const [repositories, setRepositories] = useState<Repository[]>([]);
const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
const [repoLoading, setRepoLoading] = useState(true);
const [showRepoDropdown, setShowRepoDropdown] = useState(false);
```

Add useEffect to load repositories:

```typescript
  useEffect(() => {
    loadRepositories();
  }, []);

  async function loadRepositories() {
    try {
      setRepoLoading(true);
      const repos = await api.repositories.list();
      setRepositories(repos);
    } catch (err) {
      console.error("Failed to load repositories:", err);
    } finally {
      setRepoLoading(false);
    }
  }
```

- [ ] **Step 2: Update handleSubmit to include repositoryIds**

Modify the `handleSubmit` function to pass `repositoryIds`:

```typescript
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (selectedRepoIds.length === 0) {
      setError("Please select at least one repository");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      let finalDescription = description;
      if (selectedIssues.length > 0) {
        const jiraContext = selectedIssues
          .map(key => jiraIssues.find(i => i.key === key))
          .filter(Boolean)
          .map(issue => `[${issue!.key}] ${issue!.summary}`)
          .join("\n");
        finalDescription = `${description}\n\nJIRA Tickets:\n${jiraContext}`;
      }

      const project = await api.projects.create({
        name: name.trim(),
        description: finalDescription.trim(),
        repositoryIds: selectedRepoIds,
      });
      navigate(`/projects/${project.id}/chat`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  }
```

- [ ] **Step 3: Add repository selection UI**

Add after the description textarea, before the error div:

```tsx
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Repositories *
          </label>
          {repoLoading ? (
            <div className="text-gray-400">Loading repositories...</div>
          ) : repositories.length === 0 ? (
            <div className="text-gray-400">
              No repositories configured.{" "}
              <a href="/settings" className="text-blue-400 hover:text-blue-300">
                Add repositories in Settings
              </a>
            </div>
          ) : (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRepoDropdown(!showRepoDropdown)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-left text-white focus:outline-none focus:border-blue-500"
              >
                {selectedRepoIds.length === 0
                  ? "Select repositories..."
                  : `${selectedRepoIds.length} selected`}
              </button>
              {showRepoDropdown && (
                <div className="absolute z-10 mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {repositories.map((repo) => (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => {
                        setSelectedRepoIds((prev) =>
                          prev.includes(repo.id)
                            ? prev.filter((id) => id !== repo.id)
                            : [...prev, repo.id]
                        );
                      }}
                      className={`w-full px-4 py-2 text-left hover:bg-gray-700 ${
                        selectedRepoIds.includes(repo.id) ? "bg-blue-900/50" : ""
                      }`}
                    >
                      <div className="font-medium">{repo.name}</div>
                      <div className="text-sm text-gray-400">{repo.cloneUrl}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {selectedRepoIds.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {selectedRepoIds.map((id) => {
                const repo = repositories.find((r) => r.id === id);
                if (!repo) return null;
                return (
                  <span
                    key={id}
                    className="bg-blue-900/50 border border-blue-700 rounded px-2 py-1 text-sm flex items-center gap-1"
                  >
                    {repo.name}
                    <button
                      type="button"
                      onClick={() => setSelectedRepoIds((prev) => prev.filter((rid) => rid !== id))}
                      className="text-gray-400 hover:text-white"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
```

Update the submit button to check for repositories:

```tsx
          <button
            type="submit"
            disabled={loading || !name.trim() || selectedRepoIds.length === 0}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
          >
            {loading ? "Creating..." : "Create Project"}
          </button>
```

- [ ] **Step 4: Update api.projects.create type**

Modify `frontend/src/lib/api.ts` to update the projects.create method signature:

```typescript
    create: (data: { name: string; description: string; repositoryIds?: string[] }) =>
      fetchJson<Project>(`${API_BASE}/projects`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Test manually**

Run: `cd backend && npm run dev` and `cd frontend && npm run dev`
Create repositories in Settings, then create a new project with repositories selected.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/NewProject.tsx frontend/src/lib/api.ts
git commit -m "feat(frontend): add repository multi-select to NewProject page"
```

---

### Task 6: Backend — Handle repositoryIds on Project Creation

**Files:**
- Modify: `backend/src/api/projects.ts`

- [ ] **Step 1: Verify projects API already supports repositoryIds**

The existing `Project` model already has `repositoryIds: string[]` and the store should already handle it. Check `backend/src/api/projects.ts` and `backend/src/store/projects.ts` to confirm.

If the projects API doesn't include repositoryIds in the create payload, add it:

```typescript
// In createProject handler, ensure repositoryIds is included:
const project: Project = {
  id: randomUUID(),
  name,
  status: "brainstorming",
  source: source ?? { type: "freeform" },
  repositoryIds: repositoryIds ?? [],
  // ... rest
};
```

- [ ] **Step 2: Verify the store handles repositoryIds**

Check `backend/src/store/projects.ts` to ensure `repositoryIds` is stored as JSON.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit if changes were needed, otherwise skip**

```bash
git add backend/src/api/projects.ts backend/src/store/projects.ts
git commit -m "feat(backend): ensure repositoryIds handled on project creation"
```

---

### Task 7: E2E Test — Repository Flow

**Files:**
- Create: `e2e-tests/tests/repository-flow.spec.ts`

- [ ] **Step 1: Create E2E test file**

Create `e2e-tests/tests/repository-flow.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';

test.describe('Repository Configuration Flow', () => {
  test.beforeEach(async ({ page, request }) => {
    // Seed a test repository
    await request.post(`${API_BASE}/repositories`, {
      data: {
        name: 'E2E Test Repo',
        provider: 'github',
        providerConfig: {
          owner: process.env.TEST_REPO_OWNER || 'dreef3',
          repo: process.env.TEST_REPO_NAME || 'multi-agent-harness-test-repo',
        },
        defaultBranch: 'main',
        cloneUrl: `https://github.com/${process.env.TEST_REPO_OWNER || 'dreef3'}/${process.env.TEST_REPO_NAME || 'multi-agent-harness-test-repo'}.git`,
      },
    });

    // Navigate to home
    await page.goto('/');
    await expect(page.getByText('Multi-Agent Harness')).toBeVisible();
  });

  test('create project with repository and verify PR creation', async ({ page, request }) => {
    const projectName = `E2E Repo Test ${Date.now()}`;

    // 1. Navigate to new project
    await page.getByRole('link', { name: /\+ new project/i }).click();
    await expect(page.getByRole('heading', { name: /create new project/i })).toBeVisible();

    // 2. Fill in project details
    await page.getByPlaceholder(/my awesome project/i).fill(projectName);
    await page.getByPlaceholder(/what do you want to build/i).fill(
      'Add a README.md file with a brief project description. The README should include the project name and a one-sentence description.'
    );

    // 3. Select repository
    const repoDropdown = page.getByRole('button', { name: /select repositories/i });
    await repoDropdown.click();
    await page.getByText('E2E Test Repo').click();
    await page.getByRole('button', { name: /select repositories/i }).click(); // Close dropdown

    // Verify repository is selected
    await expect(page.getByText('E2E Test Repo')).toBeVisible();

    // 4. Create project
    await page.getByRole('button', { name: /create project/i }).click();

    // 5. Wait for redirect to chat page
    await expect(page).toHaveURL(/\/projects\/[\w-]+\/chat/, { timeout: 10000 });

    // 6. Wait for chat interface
    await expect(page.getByPlaceholder(/type your message/i)).toBeVisible({ timeout: 10000 });

    // 7. Send a message to trigger brainstorming
    const testMessage = 'Please create a README.md file with the project description';
    await page.getByPlaceholder(/type your message/i).fill(testMessage);
    await page.getByRole('button', { name: /send/i }).click();

    // 8. Wait for agent response (long timeout for AI)
    const assistantMessages = page.locator('.bg-gray-800');
    await expect(assistantMessages.first()).toBeVisible({ timeout: 180000 });

    // 9. Navigate to plan page
    const currentUrl = page.url();
    const projectId = currentUrl.match(/\/projects\/([\w-]+)\/chat/)?.[1];
    expect(projectId).toBeDefined();
    await page.goto(`/projects/${projectId}/plan`);

    // 10. Wait for plan to be ready
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible({ timeout: 180000 });

    // 11. Approve the plan
    await page.getByRole('button', { name: /approve/i }).click();

    // 12. Wait for execution status
    await expect(page.getByText(/executing/i)).toBeVisible({ timeout: 60000 });

    // 13. Poll for PR creation (up to 10 minutes)
    let prCreated = false;
    const maxAttempts = 120; // 120 * 5 seconds = 10 minutes
    
    for (let i = 0; i < maxAttempts; i++) {
      const response = await request.get(`${API_BASE}/projects/${projectId}/prs`);
      if (response.ok) {
        const prs = await response.json();
        if (prs && prs.length > 0) {
          const pr = prs[0];
          expect(pr.status).toBe('open');
          expect(pr.url).toContain('github.com');
          prCreated = true;
          break;
        }
      }
      // Wait 5 seconds before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    expect(prCreated).toBe(true);

    // Take screenshot for verification
    await page.screenshot({ path: 'test-results/repo-flow-success.png', fullPage: true });
  });

  test.afterEach(async ({ request }) => {
    // Cleanup: Delete test repository
    const repos = await request.get(`${API_BASE}/repositories`);
    if (repos.ok) {
      const data = await repos.json();
      for (const repo of data) {
        if (repo.name === 'E2E Test Repo') {
          await request.delete(`${API_BASE}/repositories/${repo.id}`);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Update playwright config for longer timeouts**

Modify `e2e-tests/playwright.config.ts` to increase timeout for AI-related tests:

```typescript
export default defineConfig({
  // ... existing config
  timeout: 60000, // Increased from 30000 for AI response times
  expect: {
    timeout: 50000, // Increased from25000
  },
});
```

- [ ] **Step 3: Create test script for repository flow**

Add to `e2e-tests/package.json`:

```json
{
  "scripts": {
    "test": "bunx playwright test",
    "test:repo": "bunx playwright test tests/repository-flow.spec.ts",
    "test:ui": "bunx playwright test --ui"
  }
}
```

- [ ] **Step 4: Document required environment variables**

Add to `e2e-tests/README.md` (create if doesn't exist):

```markdown
# E2E Tests

## Repository Flow Test

The repository flow test requires:

- A GitHub repository with write access
- `GITHUB_TOKEN` environment variable with `repo` scope
- `TEST_REPO_OWNER` and `TEST_REPO_NAME` environment variables (defaults to dreef3/multi-agent-harness-test-repo)

### Running

```bash
GITHUB_TOKEN=your_token bun run test:repo
```
```

- [ ] **Step 5: Commit**

```bash
git add e2e-tests/tests/repository-flow.spec.ts e2e-tests/playwright.config.ts e2e-tests/package.json
git commit -m "feat(e2e): add repository configuration flow E2E test"
```

---

### Task 8: Integration Test — Manual Verification

**Files:** None (manual testing)

- [ ] **Step 1: Start backend and frontend**

Run: `npm run dev` (or separate `cd backend && npm run dev` and `cd frontend && npm run dev`)

- [ ] **Step 2: Configure environment**

Ensure `.env` has:
```
GITHUB_TOKEN=<your-token>
```

- [ ] **Step 3: Add repository in Settings**

Navigate to `/settings`, add a GitHub repository (use a repo you have write access to)

- [ ] **Step 4: Create project with repository**

Navigate to `/projects/new`, enter name/description, select repository, create project

- [ ] **Step 5: Verify plan approval flow**

Go through brainstorming, navigate to plan page, approve plan

- [ ] **Step 6: Verify sub-agent execution**

Watch execution status, verify PR is created in the target repository

- [ ] **Step 7: Run E2E test**

Run: `cd e2e-tests && GITHUB_TOKEN=your_token bun run test:repo`

Expected: Test passes with PR created

---

## Rollout Summary

1. Backend: Settings endpoint for provider credential status
2. Frontend: Repository management in Settings page
3. Frontend: Repository multi-select in NewProject page
4. Backend: Ensure repositoryIds handled on project creation5. E2E: Full flow test from project creation to PR creation

All changes are additive — no breaking changes to existing functionality.