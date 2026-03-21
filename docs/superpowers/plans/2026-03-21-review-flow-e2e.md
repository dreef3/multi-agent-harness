# Review-Flow E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `runFixRun` to be compatible with `runner.mjs`, then add an E2E test that posts a GitHub review comment, triggers a fix-run via API, and verifies the comment is marked "fixed" with a new commit pushed.

**Architecture:** `runner.mjs` reads all config from env vars (not stdin), so `runFixRun` must pass the fix task as `taskDescription` instead of using `SubAgentBridge`. The E2E test uses only API calls (no UI) — it seeds a repo and project via API, injects a plan, approves it, waits for the sub-agent to push a branch and open a PR, posts a GitHub comment, syncs it, triggers a fix-run, and asserts the comment is "fixed" and a new commit appears on the branch.

**Tech Stack:** TypeScript, Playwright (API-only fixture), Dockerode, GitHub REST API (`@octokit/rest` via `GITHUB_TOKEN`), Express backend.

---

## File Map

| File | Action | Change |
|------|--------|--------|
| `backend/src/orchestrator/taskDispatcher.ts` | Modify | Remove `SubAgentBridge` usage from `runFixRun`; pass `taskDescription` env var instead |
| `backend/src/agents/subAgentBridge.ts` | No change | Leave in place (may be used elsewhere) |
| `e2e-tests/tests/review-flow.spec.ts` | Create | New E2E test for the fix-run flow |

---

### Task 1: Remove SubAgentBridge from `runFixRun`

**Files:**
- Modify: `backend/src/orchestrator/taskDispatcher.ts:10,327-349`

**Context:** `runFixRun` currently creates a container, then attaches `SubAgentBridge` to stdin and sends `{type:"fix", comments}`. But `runner.mjs` reads from env vars only — it never reads stdin. The bridge send is a no-op and the container exits after its AI task (or fallback). The fix: remove the bridge, pass the fix description as `taskDescription` to `createSubAgentContainer`.

- [ ] **Step 1: Remove the `SubAgentBridge` import** from `taskDispatcher.ts`

  In `backend/src/orchestrator/taskDispatcher.ts`, delete this line:
  ```typescript
  import { SubAgentBridge } from "../agents/subAgentBridge.js";
  ```

- [ ] **Step 2: Update `createSubAgentContainer` call in `runFixRun`**

  Replace the existing `createSubAgentContainer` call (around line 327) and the bridge block (lines 337–349) so the function reads:

  ```typescript
  // Create container for fix-run (using existing branch)
  const taskDescription = `Address the following code review comments on the pull request branch "${pr.branch}":\n\n${commentsText}\n\nMake any necessary code changes and ensure the changes are committed.`;

  containerId = await createSubAgentContainer(docker, {
    sessionId,
    repoCloneUrl: repository.cloneUrl,
    branchName: pr.branch,
    taskDescription,
  });

  updateAgentSession(sessionId, { containerId, status: "running" });
  await startContainer(docker, containerId);

  // Wait for completion
  const completed = await this.waitForCompletion(docker, sessionId, containerId);

  if (!completed) {
    throw new Error("Fix-run timed out or container failed");
  }
  ```

  (Remove the lines that construct a `SubAgentBridge`, call `bridge.attach`, `bridge.send`, and `bridge.detach`.)

- [ ] **Step 3: Verify the backend compiles**

  Run: `cd /home/ae/multi-agent-harness/backend && npx tsc --noEmit`

  Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

  ```bash
  cd /home/ae/multi-agent-harness
  git add backend/src/orchestrator/taskDispatcher.ts
  git commit -m "fix: runFixRun passes task as env var instead of SubAgentBridge stdin"
  ```

---

### Task 2: Write review-flow E2E test

**Files:**
- Create: `e2e-tests/tests/review-flow.spec.ts`

**Context:** The test runs API-only (no browser). It:
1. Seeds a test repository and project via API.
2. Injects a plan that creates a marker file, sets `status: 'awaiting_approval'`.
3. Approves the plan (`POST /api/projects/:id/approve`) — this starts the sub-agent container.
4. Polls `GET /api/projects/:id/agents` until a `type=sub, status=completed` session appears.
5. Polls `GET /api/pull-requests/project/:projectId` until a PR appears (sub-agent pushes branch and creates PR).
6. Posts a generic PR-level issue comment via GitHub API.
7. Records commit count on the PR branch (baseline for verifying new commit later).
8. Syncs the comment into harness (`POST /api/pull-requests/:prId/sync`).
9. Triggers fix-run (`POST /api/pull-requests/:prId/fix`) — this call blocks until container exits.
10. Asserts the HTTP 200 body includes `success: true`.
11. Verifies the comment is now "fixed" by polling `GET /api/pull-requests/:prId`.
12. Verifies a new commit appeared on the PR branch via GitHub API.

**Why API-only:** No UI interaction needed — this flow is fully testable through the REST API, and avoids flakiness from the master-agent brainstorm step.

**PR creation timing:** `runTask` calls `createPr()` non-fatally after the container exits. The PR may take a few seconds to appear after the agent session completes; the test polls with a 30-second window.

**The fix-run HTTP call blocks:** `POST /api/pull-requests/:id/fix` awaits `runFixRun` inline, so a 200 response means the fix run finished successfully and comments are already marked "fixed". Set a generous timeout on that request (15 minutes).

- [ ] **Step 1: Create the test file with scaffolding**

  Create `e2e-tests/tests/review-flow.spec.ts`:

  ```typescript
  import { test, expect } from '@playwright/test';

  const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
  const GH_TOKEN = process.env.GITHUB_TOKEN || '';
  const TEST_REPO_OWNER = 'dreef3';
  const TEST_REPO_NAME = 'multi-agent-harness-test-repo';
  const TEST_REPO_HTTPS_URL = `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}.git`;
  const GH_HEADERS = { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' };

  test.describe('Review Comment Fix-Run Flow', () => {
    test.beforeEach(async ({ request }) => {
      await request.post(`${API_BASE}/repositories`, {
        data: {
          name: 'E2E Test Repo',
          provider: 'github',
          providerConfig: { owner: TEST_REPO_OWNER, repo: TEST_REPO_NAME },
          defaultBranch: 'main',
          cloneUrl: TEST_REPO_HTTPS_URL,
        },
      });
    });

    test.afterEach(async ({ request }) => {
      const repos = await request.get(`${API_BASE}/repositories`);
      if (repos.ok) {
        const data = await repos.json();
        for (const repo of (data as { id: string; name: string }[])) {
          if (repo.name === 'E2E Test Repo') {
            await request.delete(`${API_BASE}/repositories/${repo.id}`);
          }
        }
      }
    });

    test('fix-run marks comments fixed and pushes new commit', async ({ request }) => {
      test.setTimeout(20 * 60 * 1000); // 20 minutes — covers two sub-agent runs
      // ... (implementation steps below)
    });
  });
  ```

- [ ] **Step 2: Implement — create project and inject plan**

  Inside the test body, after the `test.setTimeout` line:

  ```typescript
  // ── 1. Get the seeded repository ID ──────────────────────────────────────
  const reposRes = await request.get(`${API_BASE}/repositories`);
  const repos = await reposRes.json() as { id: string; name: string }[];
  const testRepo = repos.find(r => r.name === 'E2E Test Repo');
  expect(testRepo).toBeDefined();
  const repoId = testRepo!.id;

  // ── 2. Create a project linked to the repository ─────────────────────────
  const projectRes = await request.post(`${API_BASE}/projects`, {
    data: {
      name: `Review Flow E2E ${Date.now()}`,
      description: 'E2E test for review comment fix-run',
      repositoryIds: [repoId],
    },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as { id: string };
  const projectId = project.id;

  // ── 3. Inject a plan (skip master agent) ─────────────────────────────────
  const taskId = `e2e-task-${Date.now()}`;
  await request.patch(`${API_BASE}/projects/${projectId}`, {
    data: {
      plan: {
        id: `e2e-plan-${Date.now()}`,
        projectId,
        content: '### Task 1: Create review-flow-marker.md\n**Repository:** E2E Test Repo\n**Description:**\nCreate review-flow-marker.md.',
        tasks: [{
          id: taskId,
          repositoryId: repoId,
          description: 'Create a file called `review-flow-marker.md` with the single line "# Review Flow Marker". Commit it to a new branch.',
          status: 'pending',
        }],
        approved: false,
      },
      status: 'awaiting_approval',
    },
  });
  ```

- [ ] **Step 3: Implement — approve plan and poll for sub-agent completion**

  ```typescript
  // ── 4. Approve the plan ───────────────────────────────────────────────────
  const approveRes = await request.post(`${API_BASE}/projects/${projectId}/approve`);
  expect(approveRes.ok()).toBe(true);

  // ── 5. Poll for sub-agent session completing ──────────────────────────────
  await expect.poll(
    async () => {
      const res = await request.get(`${API_BASE}/projects/${projectId}/agents`);
      if (!res.ok()) return false;
      const sessions = await res.json() as { type: string; status: string }[];
      return sessions.some(s => s.type === 'sub' && s.status === 'completed');
    },
    { timeout: 10 * 60 * 1000, intervals: [10000] }
  ).toBe(true);
  ```

- [ ] **Step 4: Implement — wait for PR, post comment, record baseline commit count**

  ```typescript
  // ── 6. Poll for PR to appear in harness ──────────────────────────────────
  let prId: string | undefined;
  let prBranch: string | undefined;
  let prNumber: number | undefined;

  await expect.poll(
    async () => {
      const res = await request.get(`${API_BASE}/pull-requests/project/${projectId}`);
      if (!res.ok()) return false;
      const prs = await res.json() as { id: string; branch: string; externalId: string }[];
      if (prs.length === 0) return false;
      prId = prs[0].id;
      prBranch = prs[0].branch;
      prNumber = parseInt(prs[0].externalId, 10);
      return true;
    },
    { timeout: 30000, intervals: [5000] }
  ).toBe(true);

  expect(prId).toBeDefined();
  expect(prBranch).toBeDefined();
  expect(prNumber).toBeGreaterThan(0);

  // ── 7. Record baseline commit count on the PR branch ─────────────────────
  const baselineCommitsRes = await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/commits?sha=${prBranch}&per_page=100`,
    { headers: GH_HEADERS }
  );
  const baselineCommits = await baselineCommitsRes.json() as { sha: string }[];
  const baselineCount = baselineCommits.length;

  // ── 8. Post a generic PR-level comment via GitHub API ────────────────────
  const commentRes = await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Please add a brief comment explaining what this file is for.' }),
    }
  );
  expect(commentRes.ok).toBe(true);
  ```

- [ ] **Step 5: Implement — sync, fix, assert**

  ```typescript
  // ── 9. Sync comments into harness ─────────────────────────────────────────
  const syncRes = await request.post(`${API_BASE}/pull-requests/${prId}/sync`);
  expect(syncRes.ok()).toBe(true);
  const syncData = await syncRes.json() as { synced: number };
  expect(syncData.synced).toBeGreaterThan(0);

  // ── 10. Trigger fix-run (blocks until container exits) ───────────────────
  // Use a generous timeout — the container must clone, run AI, commit, push
  const fixRes = await request.post(
    `${API_BASE}/pull-requests/${prId}/fix`,
    { timeout: 15 * 60 * 1000 }
  );
  expect(fixRes.ok()).toBe(true);
  const fixData = await fixRes.json() as { success: boolean };
  expect(fixData.success).toBe(true);

  // ── 11. Verify comments are "fixed" in harness ───────────────────────────
  const prDetailRes = await request.get(`${API_BASE}/pull-requests/${prId}`);
  expect(prDetailRes.ok()).toBe(true);
  const prDetail = await prDetailRes.json() as { comments: { status: string }[] };
  expect(prDetail.comments.every(c => c.status === 'fixed')).toBe(true);

  // ── 12. Verify new commit pushed to PR branch ────────────────────────────
  await expect.poll(
    async () => {
      const res = await fetch(
        `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/commits?sha=${prBranch}&per_page=100`,
        { headers: GH_HEADERS }
      );
      if (!res.ok) return false;
      const commits = await res.json() as { sha: string }[];
      return commits.length > baselineCount;
    },
    { timeout: 30000, intervals: [5000] }
  ).toBe(true);
  ```

- [ ] **Step 6: Run the test locally (dry-run — no docker) to verify TypeScript compiles**

  ```bash
  cd /home/ae/multi-agent-harness/e2e-tests
  npx tsc --noEmit
  ```

  Expected: no TypeScript errors. (The test itself won't pass without a running harness+docker, but the type check confirms the code is correct.)

- [ ] **Step 7: Commit**

  ```bash
  cd /home/ae/multi-agent-harness
  git add e2e-tests/tests/review-flow.spec.ts
  git commit -m "test(e2e): add review-flow fix-run E2E test"
  ```

---

### Task 3: Verify CI config covers new test

**Files:**
- Read: `.github/workflows/e2e.yml`

- [ ] **Step 1: Check that the existing CI workflow runs all spec files**

  Run: `grep -n "spec" /home/ae/multi-agent-harness/.github/workflows/e2e.yml`

  If the workflow already runs `tests/**/*.spec.ts` or similar glob, no changes needed.
  If it lists specific files, add `review-flow.spec.ts` to the list.

- [ ] **Step 2: Verify `GITHUB_TOKEN` is passed to e2e tests in CI**

  Run: `grep -n "GITHUB_TOKEN" /home/ae/multi-agent-harness/.github/workflows/e2e.yml`

  Expected: `GITHUB_TOKEN` appears in the env block for the e2e step.
  If missing: add `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to that step's env.

- [ ] **Step 3: Commit any CI changes (skip if no changes needed)**

  ```bash
  cd /home/ae/multi-agent-harness
  git add .github/workflows/e2e.yml
  git commit -m "ci: ensure review-flow E2E test is included and GITHUB_TOKEN is passed"
  ```

---

### Task 4: Push branch and create PR

- [ ] **Step 1: Push branch**

  ```bash
  cd /home/ae/multi-agent-harness
  git push -u origin feat/review-flow-e2e
  ```

- [ ] **Step 2: Create PR**

  ```bash
  gh pr create \
    --title "feat: review-flow fix-run E2E test" \
    --body "$(cat <<'EOF'
  ## Summary
  - Fix `runFixRun` to pass fix task as `TASK_DESCRIPTION` env var (was using SubAgentBridge stdin which runner.mjs never reads)
  - Add E2E test for review comment fix-run: posts GitHub comment → syncs → triggers fix → asserts comment=fixed and new commit pushed

  ## Test plan
  - [ ] CI E2E job passes (both `repository-flow` and `review-flow` specs)
  - [ ] Backend TypeScript compiles without errors
  EOF
  )"
  ```
