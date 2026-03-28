# Git Clone Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce per-task container startup time by 20–55s by using a shared bare-repo cache volume with `git worktree` instead of a full `git clone` on every sub-agent run.

**Architecture:** A named Docker volume `harness-repo-cache` is mounted at `/cache` in sub-agent containers. On first use, the runner creates a bare clone at `/cache/<sanitized-repo-id>/`; on subsequent runs it fetches and creates a lightweight worktree at `/workspace/repo`. After the AI work completes the worktree is pruned from the bare repo. The planning agent is unchanged (it already does fetch-based updates). The cache volume is opt-in via `HARNESS_REPO_CACHE_VOLUME` env var; a blank value disables the cache and falls back to the existing `git clone` path.

**Tech Stack:** Docker named volumes, bare git repos, git worktrees, ESM (Bun), TypeScript (`containerManager.ts`, `config.ts`), `docker-compose.yml`.

---

## Step 1 — Add `harness-repo-cache` volume to `docker-compose.yml`

- [ ] Read `docker-compose.yml` (already read — reference the existing `volumes:` section at the bottom).

Current `volumes:` block:
```yaml
volumes:
  harness-data:
    name: harness-data
  harness-pi-auth:
    name: harness-pi-auth
```

- [ ] Add the new volume to the `volumes:` section:

```yaml
volumes:
  harness-data:
    name: harness-data
  harness-pi-auth:
    name: harness-pi-auth
  harness-repo-cache:
    name: harness-repo-cache
```

The `sub-agent` service in `docker-compose.yml` has `profiles: [build-only]` so it is not run by `docker compose up`. The volume mount is added programmatically via `containerManager.ts` (Step 3). No change to the `sub-agent:` service block in `docker-compose.yml` is needed.

---

## Step 2 — Add `repoCacheVolume` to `backend/src/config.ts`

- [ ] Read `backend/src/config.ts` (already read — reference the `export const config = { ... }` object).

- [ ] Add `repoCacheVolume` as the last property in the `config` object:

```typescript
  // Named Docker volume for bare-repo cache shared across sub-agent containers.
  // Set HARNESS_REPO_CACHE_VOLUME="" to disable caching entirely (fallback to git clone).
  repoCacheVolume: process.env.HARNESS_REPO_CACHE_VOLUME ?? "harness-repo-cache",
```

The full addition in context:

```typescript
export const config = {
  // ... existing properties ...
  testRepoUrl: process.env.TEST_REPO_URL ?? "git@github.com:dreef3/multi-agent-harness-test-repo.git",
  // Named Docker volume for bare-repo cache shared across sub-agent containers.
  // Set HARNESS_REPO_CACHE_VOLUME="" to disable caching entirely (fallback to git clone).
  repoCacheVolume: process.env.HARNESS_REPO_CACHE_VOLUME ?? "harness-repo-cache",
};
```

---

## Step 3 — Add `REPO_CACHE_DIR` env var and bind mount in `containerManager.ts`

- [ ] Read `backend/src/orchestrator/containerManager.ts` (already read — reference lines 86–105).

Current `docker.createContainer` call has:
```typescript
    HostConfig: {
      Binds: [
        `${config.piAgentVolume}:/pi-agent`,
      ],
      Memory: config.subAgentMemoryBytes,
      NanoCpus: config.subAgentCpuCount * 1_000_000_000,
      NetworkMode: config.subAgentNetwork,
    },
```

- [ ] Update the `Binds` array and `Env` array to include the cache volume when configured. In `createSubAgentContainer`, change the `Binds` line to:

```typescript
      Binds: [
        // Shared pi-agent dir so sub-agents can use OAuth tokens (e.g. GitHub Copilot)
        `${config.piAgentVolume}:/pi-agent`,
        // Shared bare-repo cache — eliminates full git clone per task
        ...(config.repoCacheVolume ? [`${config.repoCacheVolume}:/cache`] : []),
      ],
```

- [ ] Add `REPO_CACHE_DIR` to the task env array. Find the `taskEnv` array (lines 60–68):

```typescript
  const taskEnv = [
    ...(opts.taskDescription ? [`TASK_DESCRIPTION=${opts.taskDescription}`] : []),
    ...(opts.gitPushUrl ? [`GIT_PUSH_URL=${opts.gitPushUrl}`] : []),
    `AGENT_PROVIDER=${agentProvider}`,
    `AGENT_MODEL=${agentModel}`,
    `TASK_ID=${opts.taskId ?? ""}`,
    `HARNESS_API_URL=${config.harnessApiUrl}`,
    `AGENT_SESSION_ID=${opts.sessionId}`,
  ];
```

Replace with:

```typescript
  const taskEnv = [
    ...(opts.taskDescription ? [`TASK_DESCRIPTION=${opts.taskDescription}`] : []),
    ...(opts.gitPushUrl ? [`GIT_PUSH_URL=${opts.gitPushUrl}`] : []),
    `AGENT_PROVIDER=${agentProvider}`,
    `AGENT_MODEL=${agentModel}`,
    `TASK_ID=${opts.taskId ?? ""}`,
    `HARNESS_API_URL=${config.harnessApiUrl}`,
    `AGENT_SESSION_ID=${opts.sessionId}`,
    ...(config.repoCacheVolume ? [`REPO_CACHE_DIR=/cache`] : []),
  ];
```

- [ ] Add a log line in the `console.log` block to show whether caching is active:

```typescript
  console.log(`[containerManager]   repoCacheVolume=${config.repoCacheVolume || "(disabled)"}`);
```

---

## Step 4 — Update `sub-agent/runner.mjs` clone section

- [ ] Read `sub-agent/runner.mjs` lines 92–96 (already read — confirmed clone section).

Current code (lines 92–96):
```javascript
// ── Clone & checkout ──────────────────────────────────────────────────────────
console.log("[sub-agent] Cloning repository, branch:", BRANCH_NAME);
git("clone", REPO_CLONE_URL, "/workspace/repo");   // credential store handles auth
process.chdir("/workspace/repo");
git("checkout", BRANCH_NAME);
```

- [ ] Add `REPO_CACHE_DIR` constant immediately after the existing `GIT_PUSH_URL` constant (around line 41). Add after `const GIT_PUSH_URL = ...`:

```javascript
// Repo cache dir — mounted from harness-repo-cache volume by containerManager.
// Empty string means caching is disabled; fall back to regular git clone.
const REPO_CACHE_DIR = process.env.REPO_CACHE_DIR ?? "";
```

- [ ] Replace the clone section (lines 92–96) with the cache-aware checkout:

```javascript
// ── Clone & checkout (cache-aware) ───────────────────────────────────────────
// Sanitise clone URL to a filesystem-safe directory name for the bare repo.
const repoId = REPO_CLONE_URL.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
const cacheDir = REPO_CACHE_DIR ? `${REPO_CACHE_DIR}/${repoId}` : "";

if (cacheDir && fsExistsSync(`${cacheDir}/HEAD`)) {
  // Cache hit — fetch latest and create a worktree
  console.log("[sub-agent] Cache hit — fetching latest refs from origin...");
  execSync(`git -C ${JSON.stringify(cacheDir)} fetch origin --prune`, { stdio: "inherit" });
  execSync(
    `git -C ${JSON.stringify(cacheDir)} worktree add /workspace/repo ${JSON.stringify(BRANCH_NAME)}`,
    { stdio: "inherit" }
  );
  console.log("[sub-agent] Worktree created at /workspace/repo for branch:", BRANCH_NAME);
} else if (cacheDir) {
  // Cache miss — bare clone, then create a worktree
  console.log("[sub-agent] Cache miss — bare cloning into cache...");
  execSync(
    `git clone --bare ${JSON.stringify(REPO_CLONE_URL)} ${JSON.stringify(cacheDir)}`,
    { stdio: "inherit" }
  );
  execSync(
    `git -C ${JSON.stringify(cacheDir)} worktree add /workspace/repo ${JSON.stringify(BRANCH_NAME)}`,
    { stdio: "inherit" }
  );
  console.log("[sub-agent] Bare clone cached and worktree created at /workspace/repo");
} else {
  // No cache configured — fallback to regular clone
  console.log("[sub-agent] No cache configured — cloning repository, branch:", BRANCH_NAME);
  git("clone", REPO_CLONE_URL, "/workspace/repo");
  process.chdir("/workspace/repo");
  git("checkout", BRANCH_NAME);
}

// When using a worktree the chdir must happen after worktree creation
if (cacheDir) process.chdir("/workspace/repo");
```

**Important:** `execSync` with a shell command string is used here (rather than `execFileSync`) because we need shell string interpolation for the cache path variable. The repo URL and branch name are JSON-stringified to safely handle special characters. Verify that `execSync` is already imported at the top of `runner.mjs` — it is (line 15: `import { execSync, execFileSync } from "node:child_process"`).

---

## Step 5 — Add worktree cleanup after AI work completes

The worktree must be removed from the bare repo before the container exits. A stale worktree entry in the bare repo would cause the next container's `worktree add` to fail with "already checked out".

- [ ] Find the location in `runner.mjs` immediately after `session.dispose()` is called and the AI work block ends (lines 229–235). The cleanup must run after all git operations (commit + push) complete.

- [ ] Add a worktree cleanup block after the push block (after line 266, the closing `}` of the commit/push try/catch):

```javascript
// ── Worktree cleanup ──────────────────────────────────────────────────────────
if (cacheDir && fsExistsSync(`${cacheDir}/HEAD`)) {
  try {
    execSync(
      `git -C ${JSON.stringify(cacheDir)} worktree remove /workspace/repo --force`,
      { stdio: "inherit" }
    );
    execSync(
      `git -C ${JSON.stringify(cacheDir)} worktree prune`,
      { stdio: "inherit" }
    );
    console.log("[sub-agent] Worktree removed from cache for task:", TASK_ID);
  } catch (wtErr) {
    // Non-fatal — container is about to exit anyway; the next run will handle a stale entry
    console.warn("[sub-agent] Failed to remove worktree (non-fatal):", wtErr.message);
  }
}
```

**Note:** `cacheDir` is declared in the clone section (Step 4) so it is in scope here. The `git worktree prune` command cleans up any other stale administrative files.

---

## Step 6 — Handle worktree conflicts on cache hits (defensive)

If a previous container crashed before cleanup, `worktree add` will fail with "already checked out". Add a recovery fallback:

- [ ] Wrap the `git worktree add` in the cache-hit branch with a try/catch that prunesand retries once:

```javascript
if (cacheDir && fsExistsSync(`${cacheDir}/HEAD`)) {
  console.log("[sub-agent] Cache hit — fetching latest refs from origin...");
  execSync(`git -C ${JSON.stringify(cacheDir)} fetch origin --prune`, { stdio: "inherit" });

  // Attempt worktree add; on conflict, prune stale entries and retry once
  try {
    execSync(
      `git -C ${JSON.stringify(cacheDir)} worktree add /workspace/repo ${JSON.stringify(BRANCH_NAME)}`,
      { stdio: "inherit" }
    );
  } catch (addErr) {
    console.warn("[sub-agent] worktree add failed, pruning and retrying:", addErr.message);
    execSync(`git -C ${JSON.stringify(cacheDir)} worktree prune`, { stdio: "inherit" });
    execSync(
      `git -C ${JSON.stringify(cacheDir)} worktree add /workspace/repo ${JSON.stringify(BRANCH_NAME)}`,
      { stdio: "inherit" }
    );
  }
  console.log("[sub-agent] Worktree created at /workspace/repo for branch:", BRANCH_NAME);
}
```

---

## Step 7 — Add `.env.example` entry

- [ ] Read `.env.example` to understand the current format.
- [ ] Add the following line to `.env.example`:

```bash
# Named Docker volume for bare-repo cache (saves 20-55s per task via git worktrees).
# Set to empty string to disable: HARNESS_REPO_CACHE_VOLUME=
HARNESS_REPO_CACHE_VOLUME=harness-repo-cache
```

---

## Step 8 — Verify end-to-end in a local docker compose environment

- [ ] Build the sub-agent image:
  ```bash
  docker compose build sub-agent
  ```
- [ ] Start the backend:
  ```bash
  docker compose up -d backend
  ```
- [ ] Dispatch a test task that uses a known repo and observe logs:
  - First run: should log `[sub-agent] Cache miss — bare cloning into cache...`
  - Second run (same repo): should log `[sub-agent] Cache hit — fetching latest refs from origin...`
- [ ] Confirm the second run is faster by comparing timestamps in the container logs.
- [ ] Confirm that `git worktree remove` runs successfully and the next run's `worktree add` succeeds.

---

## Edge cases and notes

**Concurrent tasks on the same repo:** Two containers running simultaneously against the same repo will both attempt `git -C <cacheDir> fetch origin`. This is safe — git fetch is a read-only operation against the remote and multiple fetches can safely run concurrently against the same bare repo. The `worktree add` operations will be against different branches (each task gets its own branch), so they will not conflict.

**Branch not yet pushed to remote:** The first run for a new task branch uses `git worktree add <path> <branch>`, where `<branch>` must exist in the bare clone. Since `REPO_CLONE_URL` already has the token (via credential store) and the backend creates the branch before dispatching the task, the branch will be present after `git fetch origin`.

**Cache volume size:** A bare repo is approximately 20–30% of the size of a full clone. On large repos this may still be significant. The volume is named (not anonymous) so it persists across compose restarts and can be inspected or pruned manually if needed.

**Disabling the cache:** Set `HARNESS_REPO_CACHE_VOLUME=` (empty) in `.env` to disable caching. The runner falls back to `git clone` for 100% compatibility.

---

## Summary of files changed

| File | Change |
|---|---|
| `docker-compose.yml` | Add `harness-repo-cache` named volume |
| `backend/src/config.ts` | Add `repoCacheVolume` config property |
| `backend/src/orchestrator/containerManager.ts` | Add volume bind mount + `REPO_CACHE_DIR` env var |
| `sub-agent/runner.mjs` | Replace clone section with cache-aware checkout; add worktree cleanup |
| `.env.example` | Document `HARNESS_REPO_CACHE_VOLUME` |
