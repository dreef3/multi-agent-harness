# Project Lifecycle Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three project lifecycle bugs: spec-reviewer runs inline in planning agent; all implementation PRs merged → project completed; user chatting with a completed project reactivates it to executing.

**Architecture:** Three independent changes to three files. No new files, no new DB columns, no new types. Each change is self-contained and can be verified independently.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest, Express/ws

---

## File Map

| File | Change |
|---|---|
| `planning-agent/system-prompt.md` | Remove `dispatch_tasks` override for spec-document-reviewer |
| `backend/src/polling.ts` | After marking a PR merged, check if all project PRs are terminal and mark project completed |
| `backend/src/__tests__/polling.test.ts` | Add tests for all-merged → completed behaviour |
| `backend/src/api/websocket.ts` | Reactivate `completed` project to `executing` when user sends a prompt |
| `backend/src/__tests__/websocket.test.ts` | Add test for completed → executing reactivation |

---

## Task 1: Remove spec-reviewer sub-agent dispatch from system prompt

**Files:**
- Modify: `planning-agent/system-prompt.md`

- [ ] **Step 1: Remove the dispatch override line**

Open `planning-agent/system-prompt.md`. In the **Phase 1 — Spec Design** section, remove this line from the "Harness overrides" list (currently line 25):

```
- When the skill instructs you to dispatch a spec-document-reviewer subagent, use the `dispatch_tasks` tool for this — include the full reviewer prompt contents and the spec content in the task description.
```

After the edit, the Phase 1 overrides block should read only:

```markdown
**Harness overrides** (take precedence over the skill's defaults):
- When the skill instructs you to write the design doc to `docs/superpowers/specs/` and commit it, call `write_planning_document` with `type="spec"` and the full Markdown content instead. This publishes the spec and opens a PR. Inform the user the PR is open and await their LGTM.
```

- [ ] **Step 2: Verify the file looks correct**

```bash
grep -n "spec-document-reviewer\|dispatch_tasks" planning-agent/system-prompt.md
```

Expected output: no lines containing `spec-document-reviewer` in Phase 1 overrides. `dispatch_tasks` may appear in the Tools section and Phase 2 — that is correct.

- [ ] **Step 3: Commit**

```bash
git add planning-agent/system-prompt.md
git commit -m "fix(planning-agent): run spec-reviewer inline, remove sub-agent dispatch override"
```

---

## Task 2: Tests — all implementation PRs merged → project completed

**Files:**
- Modify: `backend/src/__tests__/polling.test.ts`

- [ ] **Step 1: Add project store mocks to the top of the test file**

The existing mock block for `../store/pullRequests.js` is already present. Add a new mock block and named mock variables for the projects store. Insert after the existing `vi.mock("../store/pullRequests.js", ...)` block:

```ts
const mockGetProject = vi.fn();
const mockUpdateProject = vi.fn();
const mockListPullRequestsByProject = vi.fn();

vi.mock("../store/projects.js", () => ({
  getProject: mockGetProject,
  updateProject: mockUpdateProject,
}));
```

Also update the existing `vi.mock("../store/pullRequests.js", ...)` block to expose `listPullRequestsByProject` as a named mock (it is already `vi.fn()` there but not assigned to a variable). Replace the existing mock:

```ts
vi.mock("../store/pullRequests.js", () => ({
  upsertReviewComment: mockUpsertReviewComment,
  listPullRequestsByProject: mockListPullRequestsByProject,
  updatePullRequest: mockUpdatePullRequest,
}));
```

- [ ] **Step 2: Add `mockGetProject` and `mockUpdateProject` to `beforeEach` resets**

In the existing `beforeEach` inside `describe("pollPullRequest — PR status sync ...")`:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepository.mockReturnValue(repo);
  mockGetDebounceEngine.mockReturnValue(null);
  // Default: project is executing, not yet completed
  mockGetProject.mockReturnValue({ id: "project-1", status: "executing" });
  mockListPullRequestsByProject.mockReturnValue([]);
});
```

- [ ] **Step 3: Add the new test cases**

Add a new `describe` block after the existing `describe("pollPullRequest — PR status sync ...")` block:

```ts
describe("pollPullRequest — project completion on all PRs merged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRepository.mockReturnValue(repo);
    mockGetDebounceEngine.mockReturnValue(null);
    mockGetProject.mockReturnValue({ id: "project-1", status: "executing" });
  });

  it("marks project completed when the only PR is merged", async () => {
    mockGetPullRequest.mockResolvedValue({ status: "merged", url: pr.url });
    // After updatePullRequest, listPullRequestsByProject returns this PR as merged
    mockListPullRequestsByProject.mockReturnValue([
      { ...pr, status: "merged" },
    ]);

    const { pollPullRequest } = await import("../polling.js");
    await pollPullRequest({} as never, pr);

    expect(mockUpdateProject).toHaveBeenCalledWith("project-1", { status: "completed" });
  });

  it("marks project completed when all PRs are merged or declined", async () => {
    const pr2: PullRequest = {
      ...pr,
      id: "pr-2",
      externalId: "43",
      status: "declined",
    };
    mockGetPullRequest.mockResolvedValue({ status: "merged", url: pr.url });
    mockListPullRequestsByProject.mockReturnValue([
      { ...pr, status: "merged" },
      { ...pr2, status: "declined" },
    ]);

    const { pollPullRequest } = await import("../polling.js");
    await pollPullRequest({} as never, pr);

    expect(mockUpdateProject).toHaveBeenCalledWith("project-1", { status: "completed" });
  });

  it("does not mark project completed when another PR is still open", async () => {
    const pr2: PullRequest = {
      ...pr,
      id: "pr-2",
      externalId: "43",
      status: "open",
    };
    mockGetPullRequest.mockResolvedValue({ status: "merged", url: pr.url });
    mockListPullRequestsByProject.mockReturnValue([
      { ...pr, status: "merged" },
      pr2,
    ]);

    const { pollPullRequest } = await import("../polling.js");
    await pollPullRequest({} as never, pr);

    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("does not mark project completed when PR is declined (not merged)", async () => {
    mockGetPullRequest.mockResolvedValue({ status: "declined", url: pr.url });

    const { pollPullRequest } = await import("../polling.js");
    await pollPullRequest({} as never, pr);

    // Declined alone does not trigger completion check
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("does not mark project completed when project is already completed", async () => {
    mockGetProject.mockReturnValue({ id: "project-1", status: "completed" });
    mockGetPullRequest.mockResolvedValue({ status: "merged", url: pr.url });
    mockListPullRequestsByProject.mockReturnValue([{ ...pr, status: "merged" }]);

    const { pollPullRequest } = await import("../polling.js");
    await pollPullRequest({} as never, pr);

    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("does not mark project completed when project is cancelled", async () => {
    mockGetProject.mockReturnValue({ id: "project-1", status: "cancelled" });
    mockGetPullRequest.mockResolvedValue({ status: "merged", url: pr.url });
    mockListPullRequestsByProject.mockReturnValue([{ ...pr, status: "merged" }]);

    const { pollPullRequest } = await import("../polling.js");
    await pollPullRequest({} as never, pr);

    expect(mockUpdateProject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/polling.test.ts 2>&1 | tail -30
```

Expected: the new tests fail with errors like `mockUpdateProject is not a function` or `Expected to be called` — this confirms the tests are wired up and the implementation is missing.

---

## Task 3: Implement — all implementation PRs merged → project completed

**Files:**
- Modify: `backend/src/polling.ts`

- [ ] **Step 1: Add the completion check after PR status update**

In `pollPullRequest`, find the block that handles a non-open PR (around line 46–51). Currently:

```ts
if (prInfo.status !== "open") {
  updatePullRequest(pr.id, { status: prInfo.status });
  console.log(`[polling] PR ${pr.id} is ${prInfo.status} on remote — updated local status, skipping comment poll`);
  pollStates.delete(pr.id);
  return 0;
}
```

Replace with:

```ts
if (prInfo.status !== "open") {
  updatePullRequest(pr.id, { status: prInfo.status });
  console.log(`[polling] PR ${pr.id} is ${prInfo.status} on remote — updated local status, skipping comment poll`);

  // When a PR is merged, check if all project PRs are now terminal → mark project completed
  if (prInfo.status === "merged") {
    const project = getProject(pr.projectId);
    if (project && project.status !== "completed" && project.status !== "cancelled") {
      const allPrs = listPullRequestsByProject(pr.projectId);
      const allTerminal = allPrs.every(p => p.status === "merged" || p.status === "declined");
      if (allTerminal) {
        updateProject(pr.projectId, { status: "completed" });
        console.log(`[polling] All PRs for project ${pr.projectId} are terminal — marking project completed`);
      }
    }
  }

  pollStates.delete(pr.id);
  return 0;
}
```

Note: `updatePullRequest` is called first, so when `listPullRequestsByProject` runs immediately after, the DB already reflects the merged status for this PR.

Note: `getProject`, `updateProject`, and `listPullRequestsByProject` are all already imported at the top of `polling.ts` — no new imports needed.

- [ ] **Step 2: Run the tests to confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/polling.test.ts 2>&1 | tail -30
```

Expected: all tests pass including the six new ones.

- [ ] **Step 3: Commit**

```bash
git add backend/src/polling.ts backend/src/__tests__/polling.test.ts
git commit -m "feat(polling): mark project completed when all implementation PRs are merged"
```

---

## Task 4: Tests — completed project reactivates to executing on user prompt

**Files:**
- Modify: `backend/src/__tests__/websocket.test.ts`

- [ ] **Step 1: Add a mock for `updateProject` in the websocket test**

At the top of `websocket.test.ts`, add a mock variable and a mock for the projects store. Insert after the existing `vi.mock("../store/repositories.js", ...)` block:

```ts
const mockUpdateProject = vi.fn();

vi.mock("../store/projects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/projects.js")>();
  return {
    ...actual,
    updateProject: mockUpdateProject,
  };
});
```

This partial mock lets `insertProject`, `getProject`, and `listProjects` use the real SQLite implementation (needed by the other tests), while intercepting `updateProject` calls.

Also add `mockUpdateProject.mockReset()` inside `beforeEach`:

```ts
beforeEach(async () => {
  mockManager = new MockManager();
  mockUpdateProject.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ws-test-"));
  // ... rest of beforeEach unchanged
```

- [ ] **Step 2: Update `makeProject` to accept an optional status**

```ts
function makeProject(status: Project["status"] = "brainstorming"): { projectId: string; project: Project } {
  const projectId = randomUUID();
  const project: Project = {
    id: projectId,
    name: "WS Test Project",
    status,
    source: { type: "freeform", freeformDescription: "test" },
    repositoryIds: [],
    masterSessionPath: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  insertProject(project);
  return { projectId, project };
}
```

- [ ] **Step 3: Add the new test case**

Add inside the existing `describe("WebSocket message persistence", ...)` block, after the last `it(...)`:

```ts
it("reactivates a completed project to executing when user sends a prompt", async () => {
  const { projectId } = makeProject("completed");
  const ws = await connectWs(projectId);

  ws.send(JSON.stringify({ type: "prompt", text: "What changed?" }));
  await sleep(50);
  ws.close();

  expect(mockUpdateProject).toHaveBeenCalledWith(projectId, { status: "executing" });
});

it("does not reactivate a non-completed project on user prompt", async () => {
  const { projectId } = makeProject("executing");
  const ws = await connectWs(projectId);

  ws.send(JSON.stringify({ type: "prompt", text: "Go" }));
  await sleep(50);
  ws.close();

  expect(mockUpdateProject).not.toHaveBeenCalled();
});

it("does not reactivate on steer or resume messages", async () => {
  const { projectId } = makeProject("completed");
  const ws = await connectWs(projectId);

  ws.send(JSON.stringify({ type: "steer", text: "Actually, stop" }));
  ws.send(JSON.stringify({ type: "resume", lastSeqId: 0 }));
  await sleep(50);
  ws.close();

  expect(mockUpdateProject).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```bash
cd backend && npx vitest run src/__tests__/websocket.test.ts 2>&1 | tail -30
```

Expected: the three new tests fail (`mockUpdateProject` not called when it should be, or called when it shouldn't be).

---

## Task 5: Implement — reactivate completed project on user prompt

**Files:**
- Modify: `backend/src/api/websocket.ts`

- [ ] **Step 1: Add the reactivation check in the prompt handler**

In the `ws.on("message", ...)` handler (around line 225), find the `if (msg.type === "prompt" && msg.text)` branch. Currently:

```ts
if (msg.type === "prompt" && msg.text) {
  console.log(`[ws] Received prompt for project ${projectId}: "${msg.text?.slice(0, 100)}..."`);
  try {
    appendMessage(projectId, "user", msg.text);
  } catch (err) {
    console.error(`[ws] Failed to persist user message for ${projectId}:`, err);
  }
  // Master agent prompt
  const context = buildMasterAgentContext(project, allRepos);
  console.log(`[ws] Dispatching message to planning agent for project ${projectId}`);
  await manager.sendPrompt(projectId, msg.text, context);
}
```

Replace with:

```ts
if (msg.type === "prompt" && msg.text) {
  console.log(`[ws] Received prompt for project ${projectId}: "${msg.text?.slice(0, 100)}..."`);

  // Reactivate completed projects when the user sends a new message
  const currentProject = getProject(projectId);
  if (currentProject?.status === "completed") {
    updateProject(projectId, { status: "executing" });
    console.log(`[ws] Reactivating completed project ${projectId} → executing on user prompt`);
  }

  try {
    appendMessage(projectId, "user", msg.text);
  } catch (err) {
    console.error(`[ws] Failed to persist user message for ${projectId}:`, err);
  }
  // Master agent prompt
  const context = buildMasterAgentContext(project, allRepos);
  console.log(`[ws] Dispatching message to planning agent for project ${projectId}`);
  await manager.sendPrompt(projectId, msg.text, context);
}
```

Note: `getProject` and `updateProject` are already imported at the top of `websocket.ts` — no new imports needed.

- [ ] **Step 2: Run the tests to confirm they pass**

```bash
cd backend && npx vitest run src/__tests__/websocket.test.ts 2>&1 | tail -30
```

Expected: all tests pass including the three new ones.

- [ ] **Step 3: Run the full backend test suite to check for regressions**

```bash
cd backend && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/websocket.ts backend/src/__tests__/websocket.test.ts
git commit -m "feat(ws): reactivate completed project to executing when user sends a prompt"
```
