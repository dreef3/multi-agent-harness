# Git Sync Before Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a sub-agent begins its AI session it merges the latest base branch into its feature branch, so fix-run agents and long-lived branches never start from a stale base. If the merge produces a conflict the container emits a `sync_conflict` event and exits non-zero — no AI resolution is attempted.

**Architecture:**
- `sub-agent/runner.mjs` — extract `forwardEvent` above the `try` block; add a pre-session git sync step (fetch + merge); call `forwardEvent("sync_conflict", ...)` and `process.exit(1)` on merge conflict.
- `backend/src/orchestrator/containerManager.ts` — inject `BASE_BRANCH` env var sourced from the caller.
- `backend/src/orchestrator/taskDispatcher.ts` — pass `repository.defaultBranch` as `baseBranch` when calling `createSubAgentContainer`.

**Key constraint:** The fetch must use `GIT_PUSH_URL` (authenticated) explicitly, not `origin` (which is reset to the unauthenticated URL after checkout). The sync block therefore sits between `git checkout BRANCH_NAME` and `git remote set-url origin REPO_CLONE_URL`.

**Tech Stack:** Node.js/Bun ESM (runner), TypeScript (backend), vitest (tests)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `sub-agent/runner.mjs` | **Modify** | Extract `forwardEvent`, add git sync block |
| `backend/src/orchestrator/containerManager.ts` | **Modify** | Accept + inject `BASE_BRANCH` env var |
| `backend/src/orchestrator/taskDispatcher.ts` | **Modify** | Pass `baseBranch` from `repository.defaultBranch` |
| `backend/src/__tests__/containerManager.test.ts` | **Modify** | Assert `BASE_BRANCH` is injected |

---

### Task 1: Inject `BASE_BRANCH` env var from backend

**Files:**
- Modify: `backend/src/orchestrator/containerManager.ts`
- Modify: `backend/src/__tests__/containerManager.test.ts`

- [ ] **Step 1: Write failing tests asserting BASE_BRANCH is injected**

Add to `backend/src/__tests__/containerManager.test.ts`:

```typescript
it("injects BASE_BRANCH when baseBranch option is provided", async () => {
  const mockCreate = vi.fn().mockResolvedValue({ id: "container-xyz" });
  const mockDocker = { createContainer: mockCreate };
  await createSubAgentContainer(mockDocker as never, {
    sessionId: "sess-2",
    repoCloneUrl: "https://github.com/org/repo.git",
    branchName: "feature/task-1",
    baseBranch: "develop",
  });
  const callArg = mockCreate.mock.calls[0][0] as { Env: string[] };
  expect(callArg.Env).toContain("BASE_BRANCH=develop");
});

it("injects BASE_BRANCH=main when baseBranch option is omitted", async () => {
  const mockCreate = vi.fn().mockResolvedValue({ id: "container-xyz" });
  const mockDocker = { createContainer: mockCreate };
  await createSubAgentContainer(mockDocker as never, {
    sessionId: "sess-3",
    repoCloneUrl: "https://github.com/org/repo.git",
    branchName: "feature/task-2",
  });
  const callArg = mockCreate.mock.calls[0][0] as { Env: string[] };
  expect(callArg.Env).toContain("BASE_BRANCH=main");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/containerManager.test.ts 2>&1 | tail -20
```

Expected: FAIL — `BASE_BRANCH` not present in Env.

- [ ] **Step 3: Add `baseBranch` to `ContainerCreateOptions` interface**

In `backend/src/orchestrator/containerManager.ts`, add to `ContainerCreateOptions`:

```typescript
  /** Base branch to merge before work. Defaults to "main". */
  baseBranch?: string;
```

- [ ] **Step 4: Inject BASE_BRANCH into the container Env array**

In `createSubAgentContainer`, in the `taskEnv` array, add after `AGENT_SESSION_ID`:

```typescript
  `BASE_BRANCH=${opts.baseBranch ?? "main"}`,
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/containerManager.test.ts 2>&1 | tail -20
```

Expected: all containerManager tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/orchestrator/containerManager.ts backend/src/__tests__/containerManager.test.ts
git commit -m "feat(containerManager): inject BASE_BRANCH env var into sub-agent containers"
```

---

### Task 2: Pass `baseBranch` from `taskDispatcher.ts`

**Files:**
- Modify: `backend/src/orchestrator/taskDispatcher.ts`

Depends on Task 1 (the `baseBranch` field must exist on `ContainerCreateOptions`).

- [ ] **Step 1: Pass `baseBranch` in `runTask`**

In the `createSubAgentContainer` call inside `runTask`, add:

```typescript
  baseBranch: repository.defaultBranch,
```

- [ ] **Step 2: Pass `baseBranch` in `runFixRun`**

In the `createSubAgentContainer` call inside `runFixRun`, add:

```typescript
  baseBranch: repository.defaultBranch,
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
cd backend && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/orchestrator/taskDispatcher.ts
git commit -m "feat(taskDispatcher): forward repository.defaultBranch as baseBranch to containers"
```

---

### Task 3: Extract `forwardEvent` to module scope in `runner.mjs`

**Files:**
- Modify: `sub-agent/runner.mjs`

Currently `forwardEvent` is defined inside the `try` block, making it inaccessible from the pre-session git sync code. This is a pure refactor — no behaviour changes — and is a prerequisite for Task 4.

- [ ] **Step 1: Remove `forwardEvent` from inside the `try` block**

Delete the `/** Fire-and-forget… */` comment and the entire `forwardEvent` function declaration from inside the `try` block.

- [ ] **Step 2: Insert `forwardEvent` at module scope, before the `try` block**

Add immediately before the `// ── Run AI agent` comment:

```javascript
/**
 * Fire-and-forget: POST an activity event to the harness.
 * Defined at module scope so it can be called both before and inside the AI session.
 */
async function forwardEvent(type, payload) {
  if (!HARNESS_API_URL || !AGENT_SESSION_ID) return;
  try {
    await fetch(`${HARNESS_API_URL}/api/agents/${AGENT_SESSION_ID}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload, timestamp: new Date().toISOString() }),
    });
  } catch { /* fire-and-forget */ }
}
```

- [ ] **Step 3: Confirm no duplicate declaration**

```bash
grep -n "function forwardEvent" /home/ae/multi-agent-harness/sub-agent/runner.mjs
```

Expected: exactly one match.

- [ ] **Step 4: Smoke-test Bun can parse the file**

```bash
bun --eval "import('/home/ae/multi-agent-harness/sub-agent/runner.mjs').catch(()=>{})" 2>&1 | head -5
```

Expected: no syntax errors.

- [ ] **Step 5: Commit**

```bash
git add sub-agent/runner.mjs
git commit -m "refactor(sub-agent/runner): extract forwardEvent to module scope"
```

---

### Task 4: Add pre-session git sync step in `runner.mjs`

**Files:**
- Modify: `sub-agent/runner.mjs`

Depends on Task 3 (module-scope `forwardEvent`).

- [ ] **Step 1: Read `BASE_BRANCH` env var near the top of the file**

In the env-var declarations section, add:

```javascript
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";
```

- [ ] **Step 2: Add the sync block after `git checkout BRANCH_NAME`**

Insert between `git("checkout", BRANCH_NAME);` and `// Reset origin to non-authenticated URL` (the `git remote set-url` line):

```javascript
// ── Sync base branch before work ─────────────────────────────────────────────
// Fetch via authenticated URL (before origin is stripped of credentials).
console.log(`[sub-agent] Syncing base branch: ${BASE_BRANCH}`);
try {
  git("fetch", GIT_PUSH_URL, BASE_BRANCH);
  git("merge", "--no-edit", "FETCH_HEAD");
  console.log("[sub-agent] Base branch merged successfully");
} catch (syncErr) {
  const conflictMsg = syncErr.message ?? String(syncErr);
  console.error("[sub-agent] Merge conflict during base-branch sync:", conflictMsg);
  await forwardEvent("sync_conflict", {
    baseBranch: BASE_BRANCH,
    branch: BRANCH_NAME,
    error: conflictMsg,
  });
  process.exit(1);
}
```

- [ ] **Step 3: Verify ordering is preserved**

After the sync block the next lines must still be:

```javascript
git("remote", "set-url", "origin", REPO_CLONE_URL);
delete process.env.GIT_PUSH_URL;
delete process.env.GITHUB_TOKEN;
```

Confirm:

```bash
grep -n "set-url\|GIT_PUSH_URL\|FETCH_HEAD\|sync_conflict" sub-agent/runner.mjs
```

Expected: fetch + merge lines appear before `remote set-url`.

- [ ] **Step 4: Smoke-test syntax**

```bash
bun --eval "import('/home/ae/multi-agent-harness/sub-agent/runner.mjs').catch(()=>{})" 2>&1 | head -5
```

Expected: no parse/syntax errors.

- [ ] **Step 5: Commit**

```bash
git add sub-agent/runner.mjs
git commit -m "feat(sub-agent/runner): fetch and merge base branch before starting AI session

Prevents fix-run containers from working on a stale branch base. On merge
conflict, emits sync_conflict event and exits 1 instead of attempting AI
resolution."
```

---

### Task 5: Shell integration test for git sync

**Files:**
- Create: `sub-agent/test-git-sync.sh`

- [ ] **Step 1: Create the test script**

```bash
#!/usr/bin/env bash
# Integration test: verifies sub-agent git sync merges base branch advances.
set -euo pipefail

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

git init --bare "$TMPDIR/remote.git" -q
git clone "$TMPDIR/remote.git" "$TMPDIR/repo" -q

cd "$TMPDIR/repo"
git config user.email "test@test.com"
git config user.name "Test"
echo "v1" > file.txt && git add . && git commit -m "base v1" -q
git push origin main -q

# Create feature branch
git checkout -b feature/test -q
echo "feat" > feat.txt && git add . && git commit -m "feat commit" -q
git push origin feature/test -q

# Advance main (simulating another PR merged to main)
git checkout main -q
echo "v2" > file.txt && git add . && git commit -m "base v2" -q
git push origin main -q

# Simulate sub-agent: fresh clone, checkout feature branch, fetch+merge main
git clone "$TMPDIR/remote.git" "$TMPDIR/workspace" -q
cd "$TMPDIR/workspace"
git checkout feature/test -q
git fetch "$TMPDIR/remote.git" main
git merge --no-edit FETCH_HEAD -q

git log --oneline | grep -q "base v2" && echo "PASS: base v2 merged into feature branch" || (echo "FAIL: base v2 not found"; exit 1)
git log --oneline | grep -q "feat commit" && echo "PASS: feature commit preserved" || (echo "FAIL: feat commit missing"; exit 1)
```

- [ ] **Step 2: Run it**

```bash
chmod +x sub-agent/test-git-sync.sh && bash sub-agent/test-git-sync.sh
```

Expected: two PASS lines.

- [ ] **Step 3: Commit**

```bash
git add sub-agent/test-git-sync.sh
git commit -m "test(sub-agent): shell integration test for git sync before work"
```

---

## Final Verification

- [ ] All backend tests pass:

```bash
cd backend && npx vitest run 2>&1 | tail -10
```

- [ ] Backend TypeScript clean:

```bash
cd backend && npx tsc --noEmit
```

- [ ] Shell integration test passes:

```bash
bash sub-agent/test-git-sync.sh
```

- [ ] Docker build succeeds:

```bash
docker build -t sub-agent-test:local ./sub-agent 2>&1 | tail -5
```
