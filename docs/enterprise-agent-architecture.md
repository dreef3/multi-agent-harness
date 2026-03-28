# Enterprise: Agent Architecture — Dispatch Model & Bootstrap Optimization

## Current Architecture

### Dispatch Model: Ephemeral Containers with Implicit Queue

The harness uses **one ephemeral container per task**. There is no explicit task queue — `recoveryService.dispatchTasksForProject()` calls `Promise.all()` over all pending tasks, each of which blocks on a two-level semaphore until a slot opens. The semaphore waiters array provides FIFO ordering, making it a de facto in-memory queue that is lost on process restart.

```
Planning Agent (persistent, 1 per project)
  calls dispatch_tasks
    ↓
recoveryService.dispatchTasksForProject()
  Promise.all(pendingTasks.map(dispatchWithRetry))
    ↓
Per-project semaphore (default: 1 slot)
  → acquireSlot() — waits if slot occupied
    ↓
Global semaphore (default: 3 slots)
  → acquireSlot() — waits if all slots occupied
    ↓
taskDispatcher.runTask()
  → createContainer() → startContainer() → waitForCompletion() → removeContainer()
```

### Two Agent Tiers

| | Planning Agent | Sub-Agent |
|---|---|---|
| **Lifecycle** | Persistent — one per project, runs for project lifetime | Ephemeral — one per task, destroyed after completion |
| **Container reuse** | Yes — same container handles all prompts via TCP RPC | No — fresh container every task |
| **Repo cloning** | Once on startup, `git fetch` on updates | Full `git clone` every task |
| **Framework init** | Once on startup | Every task |
| **Idle behavior** | 2-minute grace period, then stops (restarts on next prompt) | N/A — exits when done |
| **State** | Session file persists across prompts (`planning-{projectId}.jsonl`) | Session file committed to branch, then discarded |

### Sub-Agent Bootstrap Timeline

Measured from container start to AI agent receiving the task prompt:

| Step | Duration | Repeated Per Task | Cacheable |
|------|----------|-------------------|-----------|
| Container startup (Docker/K8s) | 3-10s | Yes | Image pre-pull |
| Git credential setup | ~1s | Yes | No (security — must be ephemeral) |
| `git clone` (full repo) | 10-60s (size-dependent) | Yes | **Yes — major opportunity** |
| `git checkout` branch | ~1s | Yes | N/A without clone cache |
| Copilot auth bootstrap | ~1s | Yes | Partially (shared `/pi-agent` volume) |
| pi-coding-agent framework init | 5-10s | Yes | **Yes — pre-warm opportunity** |
| Model registry resolution | 2-5s | Yes | **Yes — pre-warm opportunity** |
| Session creation + tool registration | ~2s | Yes | No |
| **Total bootstrap** | **~25-90s** | | |
| **Actual AI work** | **5-30+ min** | | |
| Commit + push results | 10-20s | Yes | No |

For a typical 10-task project, bootstrap overhead alone is **4-15 minutes** of wall time (serialized at 1 task per project). For a 3-squad enterprise deployment running 10+ projects concurrently, this becomes a significant resource and time cost.

---

## Critical Analysis: Current Approach vs Alternatives

### Option A: Current — Ephemeral Containers (Status Quo)

**How it works:** Each task gets a fresh container. Container is created, repo cloned, agent initialized, task executed, results pushed, container destroyed.

**Strengths:**
- **Clean isolation**: Every task starts from a known state. No contamination between tasks. A failed task cannot corrupt the next one.
- **Simple mental model**: One container = one task. Easy to debug, monitor, and reason about.
- **Fault tolerance**: If a container crashes, only one task is affected. Recovery creates a new container.
- **Security**: Credentials are injected per-container and deleted before AI starts. No credential leakage across tasks.
- **Resource cleanup**: No zombie containers, no leaked state, no growing disk usage from accumulated workspaces.

**Weaknesses:**
- **Bootstrap overhead**: 25-90 seconds wasted per task on operations that produce the same result every time (clone, framework init).
- **No task queue persistence**: Semaphore waiters are in-memory. If the backend restarts, queued tasks are recovered via polling (60s delay) not immediately.
- **No prioritization**: FIFO semaphore — no way to prioritize urgent tasks over routine ones.
- **Resource waste**: Full git clone downloads the entire repo history every time. For a 500MB repo, that's 500MB of network transfer per task.
- **Cold start latency**: First task in a project pays the full bootstrap cost. No warm-up mechanism.
- **Scaling ceiling**: Global semaphore (default 3) is a hard limit. Increasing it requires proportionally more host resources (4GB RAM + 2 CPU per container).

---

### Option B: Warm Pool with Task Queue

**How it works:** A pool of pre-initialized agent containers sits idle, each with the repo already cloned and the pi-coding-agent framework booted. Tasks enter a persistent queue. When a task is dispatched, it is assigned to a warm container, which checks out the correct branch and starts working immediately.

**Architecture:**

```
Task submitted
  ↓
Persistent Task Queue (SQLite/PostgreSQL table or Redis)
  ↓
Pool Manager
  ├── Warm container 1 (repo cloned, framework ready, idle)
  ├── Warm container 2 (repo cloned, framework ready, idle)
  ├── Warm container 3 (repo cloned, framework ready, busy)
  └── [scale up/down based on queue depth]
  ↓
Assign task to idle container
  → git fetch + checkout branch
  → inject task description
  → AI works
  → commit + push
  → return container to pool (reset workspace)
```

**Strengths:**
- **Near-zero dispatch latency**: Warm container already has repo + framework. Only needs `git fetch && git checkout` (~2-5s) instead of full clone (~30-60s).
- **Persistent queue**: Tasks survive backend restarts. Priority ordering possible.
- **Better resource utilization**: Pool size can be smaller than peak demand — tasks queue and wait rather than being dropped.
- **Amortized clone cost**: Clone once per container lifetime, fetch per task. For a 500MB repo across 10 tasks, this saves ~4.5GB of transfer.
- **Horizontal scaling**: Queue consumers can run on multiple hosts (with K8s).

**Weaknesses:**
- **State contamination risk**: Reused containers carry state from previous tasks. A failed task that leaves uncommitted changes, modified configs, or leaked environment variables could affect the next task. Requires a thorough workspace reset between tasks.
- **Complex lifecycle management**: Pool sizing, health checks, idle timeout, container recycling, workspace cleanup, credential rotation — all new failure modes.
- **Credential management complexity**: Credentials must be injected per-task (not per-container), rotated between tasks, and guaranteed not to leak. Current approach of "delete from env before AI starts" doesn't work when the container persists.
- **Stale repo state**: Warm containers have the repo at clone time. If multiple branches diverge significantly, `git fetch` may not be sufficient — merge conflicts, force pushes, rebases can leave the workspace in an inconsistent state.
- **Memory pressure**: Idle containers consume RAM. Three warm containers at 4GB each = 12GB of idle memory.
- **Pool cold start**: When the system starts, the pool needs to be pre-warmed — this takes the same time as N sequential cold starts. First tasks still wait.
- **Framework state**: pi-coding-agent session state is per-task. Even with a warm container, a new session must be created for each task. The framework init time (~5-10s) may not be fully eliminable.

---

### Option C: Hybrid — Ephemeral Containers with Cached Workspace Volume

**How it works:** Containers remain ephemeral (one per task, destroyed after), but a shared persistent volume caches the git repository per project. Each container mounts the cache, uses `git fetch` + `git worktree add` instead of `git clone`, and works in an isolated worktree. The volume persists across tasks.

**Architecture:**

```
Task submitted
  ↓
taskDispatcher.runTask()
  → Create ephemeral container (same as today)
  → Mount shared volume: /cache/{repoId}/ (contains bare git repo)
  → Container startup:
      if /cache/{repoId}/.git exists:
        git fetch origin           # ~2-5s
      else:
        git clone --bare <url>     # first time only, ~30-60s
      git worktree add /workspace <branch>  # ~1s
  → AI works in /workspace
  → Commit + push
  → Remove worktree: git worktree remove /workspace
  → Destroy container
```

**Strengths:**
- **Keeps ephemeral container simplicity**: Clean isolation, simple lifecycle, no state contamination.
- **Eliminates clone overhead**: After first task, all subsequent tasks use `git fetch` (~2-5s) instead of `git clone` (~30-60s). Bare repo cache stores objects once, worktrees are lightweight checkouts.
- **No pool management**: No idle containers consuming memory. No health checks, no recycling.
- **Credential isolation preserved**: Same model as today — credentials per-container, deleted before AI starts.
- **Incremental improvement**: Can be implemented by modifying `sub-agent/runner.mjs` and `containerManager.ts` without restructuring the dispatch system.

**Weaknesses:**
- **Volume management**: Persistent volumes need cleanup (stale repos, disk growth). In K8s, requires ReadWriteMany PVC shared across pods, or a sidecar/init-container pattern.
- **Lock contention**: If two sub-agents for the same repo run concurrently, the bare git repo needs locking during fetch. Git supports this natively with `gc.lock`, but it adds a potential bottleneck.
- **Framework init not addressed**: pi-coding-agent still initializes from scratch per container. The 5-10s framework overhead remains.
- **Smaller gain than pool**: Saves clone time but not container startup or framework init. Total savings ~20-55s vs ~25-85s for warm pool.

---

### Option D: Hybrid — Sidecar Workspace Manager

**How it works:** A long-running "workspace manager" sidecar (one per project or per host) maintains cloned repos and pre-initialized environments. Sub-agent containers mount the sidecar's volume and use pre-prepared workspaces. The sidecar handles git operations; the sub-agent only does AI work.

**Architecture:**

```
Workspace Manager (sidecar, long-running)
  ├── /repos/{repoId}/          # bare git repos, kept up-to-date
  ├── /workspaces/{taskId}/     # prepared worktrees per task
  └── /templates/               # pre-initialized framework state

Task submitted
  ↓
Workspace Manager:
  1. git fetch origin (if not recently fetched)
  2. git worktree add /workspaces/{taskId} {branch}
  3. Signal "ready" to backend
  ↓
taskDispatcher.runTask()
  → Create ephemeral container
  → Mount /workspaces/{taskId} as /workspace
  → Skip clone, skip checkout — workspace already prepared
  → AI works
  → Commit + push (from container)
  → Destroy container
  ↓
Workspace Manager:
  4. git worktree remove /workspaces/{taskId}
  5. Cleanup
```

**Strengths:**
- **Maximum bootstrap savings**: No clone, no checkout, no git config in the sub-agent at all. The workspace arrives ready.
- **Separation of concerns**: Git operations (clone, fetch, worktree) separated from AI operations. Each can be optimized independently.
- **Repo deduplication**: One bare repo per unique repository, shared across all tasks and projects that use it.
- **Pre-fetch possible**: Sidecar can proactively fetch latest changes before a task is even dispatched.

**Weaknesses:**
- **Significant complexity**: New service to build, deploy, monitor. Failure modes: sidecar crash, volume corruption, race conditions between prepare and mount.
- **K8s complexity**: Requires init containers or shared PVCs. Pod scheduling must co-locate sub-agent with the sidecar's volume.
- **Overkill for current scale**: At 3 concurrent sub-agents, the bootstrap savings don't justify the operational overhead. Relevant at 10+ concurrent agents.
- **git push from a different container**: The sub-agent pushes from a mounted volume owned by the sidecar. Credential injection and push auth become more complex.

---

## Comparison Matrix

| Dimension | A: Ephemeral (Current) | B: Warm Pool | C: Cached Volume | D: Sidecar Manager |
|-----------|----------------------|--------------|-------------------|---------------------|
| **Dispatch latency** | 25-90s | 2-10s | 5-15s | 3-10s |
| **Isolation** | Complete | Risk of contamination | Complete | Complete |
| **Credential safety** | Strong | Requires careful rotation | Strong | Complex |
| **Idle resource cost** | None | High (pooled containers) | Low (disk only) | Medium (sidecar process) |
| **Implementation effort** | Done | High | Low-Medium | High |
| **Queue persistence** | None (in-memory semaphore) | Yes (required) | Optional (orthogonal) | Optional (orthogonal) |
| **K8s compatibility** | Good | Good | Needs ReadWriteMany PVC | Complex |
| **Docker Compose compat** | Good | Medium | Good | Medium |
| **Framework init savings** | None | Partial | None | None |
| **Scaling ceiling** | ~5-10 agents/host | ~10-20 agents/host | ~5-10 agents/host | ~10-15 agents/host |
| **Failure blast radius** | 1 task | 1 task + pool state | 1 task | 1 task + sidecar state |

---

## Decision: Retain Ephemeral Model with Targeted Optimizations

### Design Principles

1. **No third-party runtime dependencies**: No Redis, no message broker, no external queue. The backend stays lean — SQLite (or PostgreSQL in enterprise) is the only data store.
2. **Existing recovery is sufficient**: The `RecoveryService` already handles restart resilience — stale session detection, boot recovery scan, retry with backoff. A 3-squad team (~15-30 people) will not generate load that exceeds the current semaphore model.
3. **Ephemeral containers are the right model**: Clean isolation, simple debugging, no state contamination. The overhead is worth the correctness guarantees.

Options B (warm pool) and D (sidecar manager) are **rejected** — they add operational complexity and runtime dependencies that are not justified at the expected scale. Option A (status quo) is retained as the base, with two targeted optimizations from Option C.

### Optimization 1: Git Clone Cache (Phase 0)

Cache bare git repos on a shared volume. Sub-agents use `git fetch` + `git worktree` instead of full `git clone`.

**Changes:**

1. **New volume**: `harness-repo-cache` mounted at `/cache` in sub-agent containers

2. **`containerManager.ts`**: Add volume mount
   ```typescript
   Binds: [
     `${config.piAgentVolume}:/pi-agent`,
     `${config.repoCacheVolume}:/cache`,  // NEW
   ]
   ```

3. **`sub-agent/runner.mjs`**: Replace `git clone` with cache-aware checkout
   ```javascript
   const cacheDir = `/cache/${repoId}`;
   if (fs.existsSync(`${cacheDir}/HEAD`)) {
     // Bare repo exists — fetch latest
     execSync(`git -C ${cacheDir} fetch origin`, { stdio: "inherit" });
   } else {
     // First time — bare clone
     execSync(`git clone --bare ${REPO_CLONE_URL} ${cacheDir}`, { stdio: "inherit" });
   }
   // Create isolated worktree for this task
   execSync(`git -C ${cacheDir} worktree add /workspace/repo ${BRANCH_NAME}`, { stdio: "inherit" });
   ```

4. **Cleanup**: After push, remove worktree
   ```javascript
   execSync(`git -C ${cacheDir} worktree remove /workspace/repo --force`);
   ```

5. **K8s**: ReadWriteMany PVC for the cache volume (same as `harness-pi-auth`). Git's built-in locking handles concurrent access.

6. **Docker Compose**: Named volume `harness-repo-cache`, shared across sub-agent containers.

**Expected savings:** 20-55 seconds per task after first clone. For a 10-task project: 3-9 minutes saved.

### Optimization 2: Pre-Install SDK Extensions in Image (Phase 0)

The `DefaultResourceLoader` loads pi-coding-agent extensions at startup. Pre-installing them in the Docker image eliminates the download/setup step at runtime.

**Changes:**

1. **Sub-agent Dockerfile**: Add extension pre-install step after `npm install`
   ```dockerfile
   # Pre-install pi-coding-agent extensions so they're cached in the image layer
   RUN node -e "const {DefaultResourceLoader} = require('@anthropic/pi-coding-agent'); \
     DefaultResourceLoader.preloadExtensions('/pi-agent-cache');"
   ```

2. **`sub-agent/runner.mjs`**: Point `DefaultResourceLoader` at the pre-installed cache
   ```javascript
   const loader = new DefaultResourceLoader({
     extensionCachePath: "/pi-agent-cache",
     // ... existing config
   });
   ```

3. **Same for planning-agent Dockerfile**.

**Expected savings:** 1-3 seconds per task for extension loading. Model registry resolution (~2-5s) may also benefit if the registry response is cached in the image.

**Note:** The exact API depends on `pi-coding-agent` internals. If `DefaultResourceLoader` doesn't expose a cache path option, the alternative is to run the initialization once during `docker build` and snapshot the resulting files into the image layer. This needs validation against the SDK before implementation.

### Optimization 3: SQLite-Backed Persistent Task Queue (Phase 0)

Replace the in-memory semaphore waiters with a persistent queue in the existing SQLite database. No external dependencies — uses the same DB the backend already manages.

**Current state:**
```typescript
// recoveryService.ts — waiters array is in-memory, lost on restart
private waiters: Array<() => void> = [];
```

**Target state:** Add `queued_at` and `priority` columns to the existing task tracking. The dispatch loop reads from SQLite ordered by priority (descending), then FIFO (oldest `queued_at` first).

**Schema:**
```sql
-- Extend existing task tracking:
ALTER TABLE plan_tasks ADD COLUMN queued_at TEXT;
ALTER TABLE plan_tasks ADD COLUMN priority INTEGER DEFAULT 0;  -- higher = more urgent
-- Status flow: pending → queued → executing → completed/failed
```

**Dispatch loop:**
```typescript
async function dispatchLoop() {
  while (running) {
    const task = await dequeueNextTask();  // SELECT ... WHERE status='queued' ORDER BY priority DESC, queued_at ASC LIMIT 1
    if (!task) { await sleep(1000); continue; }
    await acquireGlobalSlot();
    await acquireProjectSlot(task.projectId);
    void runTaskAndRelease(task);  // fire-and-forget, releases slots on completion
  }
}
```

**Benefits over current semaphore waiters:**

| Property | Current (in-memory) | SQLite queue |
|----------|-------------------|--------------|
| **Restart resilience** | 60s recovery delay | Immediate — queued tasks in DB |
| **Task ordering** | FIFO only | Priority + FIFO |
| **Observability** | Hidden in memory | Queryable via API/SQL |
| **Fix run priority** | Same as routine tasks | Higher priority preempts |

The in-memory semaphore slots for concurrency control are retained — the queue only replaces the waiters array, not the slot management. This is a targeted improvement that uses the existing SQLite infrastructure.

---

## Bootstrap Optimization: Quantified Impact

Estimated per-task savings for a project with 10 implementation tasks against a 200MB repository:

| Optimization | Time Saved Per Task | Total (10 tasks) | Effort |
|-------------|-------------------|-------------------|--------|
| Git clone cache | 20-55s | 3-9 min | Low-Medium |
| Pre-installed extensions | 1-3s | 0.2-0.5 min | Low |
| SQLite persistent queue | 0s (latency) / 60s (recovery) | 0-1 min saved on restart | Low |
| **Combined** | **21-58s** | **3.5-9.7 min** | **Low-Medium** |

The git clone cache captures the largest win (clone is the dominant bootstrap cost). The SQLite queue doesn't reduce per-task latency but eliminates the 60-second recovery delay on backend restart and adds priority dispatch for fix runs. All three optimizations use only existing infrastructure — no new runtime dependencies.
