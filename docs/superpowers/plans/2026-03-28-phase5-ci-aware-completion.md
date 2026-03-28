# CI-Aware Task Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `WAIT_FOR_CI` flag to `taskDispatcher` so that after a sub-agent container exits successfully, the dispatcher polls the PR branch's CI build status and marks the task as failed if CI checks fail.

**Architecture:** `taskDispatcher.ts` currently marks a task complete immediately after the container exits. With `WAIT_FOR_CI=true`, it inserts a polling loop after container exit: it calls `connector.getBuildStatus(repo, branchName)` every 30 seconds until the status resolves to `success` or `failure`, or until `CI_WAIT_TIMEOUT_MS` (default 10 minutes) elapses. The final CI result is recorded in the TraceBuilder's JSON output per attempt. A timeout is treated as failure to avoid silently skipping CI.

**Tech Stack:** TypeScript, `taskDispatcher.ts`, `VcsConnector.getBuildStatus()` (from VCS CI Extensions plan), TraceBuilder (`backend/src/orchestrator/traceBuilder.ts`), environment variables `WAIT_FOR_CI` and `CI_WAIT_TIMEOUT_MS`.

---

## Prerequisites

- [ ] VCS CI Extensions plan implemented: `connector.getBuildStatus(repo, ref)` exists and works
- [ ] Read `backend/src/orchestrator/taskDispatcher.ts` to understand: `runTask()` structure, how `waitForCompletion()` works, where `updateAgentSession()` is called, and where `createPr()` or equivalent is called
- [ ] Read `backend/src/orchestrator/traceBuilder.ts` to understand: how to add a new record type, `persistTrace()` call site
- [ ] Read `backend/src/config.ts` (or equivalent config module) to understand how to add new env-based config flags
- [ ] Confirm `getConnector(provider)` is importable from the connector registry in `taskDispatcher.ts`

---

## Task 1 — Add config flags

- [ ] Open `backend/src/config.ts` (or wherever `process.env` config is centralized)
- [ ] Add two new config entries:

```typescript
export const config = {
  // ... existing config ...

  /**
   * When true, taskDispatcher polls CI build status after sub-agent container
   * exits and marks the task failed if CI checks do not pass.
   * Default: false (disabled — safe default for repos without CI configured)
   */
  waitForCi: process.env.WAIT_FOR_CI === "true",

  /**
   * Maximum milliseconds to wait for CI checks to complete before timing out.
   * Timeout is treated as failure.
   * Default: 600000 (10 minutes)
   */
  ciWaitTimeoutMs: parseInt(process.env.CI_WAIT_TIMEOUT_MS ?? "600000", 10),
};
```

- [ ] Add to `.env.example` (or equivalent):

```env
# CI-aware completion: poll CI after sub-agent exits (default: false)
WAIT_FOR_CI=false
# Maximum time to wait for CI checks in milliseconds (default: 10 minutes)
CI_WAIT_TIMEOUT_MS=600000
```

- [ ] Run `bunx tsc --noEmit`

---

## Task 2 — Add `waitForPrCi()` method to `taskDispatcher.ts`

- [ ] Open `backend/src/orchestrator/taskDispatcher.ts`
- [ ] Add the `waitForPrCi()` private method to the `TaskDispatcher` class (or as a module-level function if the file is not class-based):

```typescript
/**
 * Polls the CI build status for the given branch until it resolves to
 * success or failure, or until the timeout is reached.
 *
 * @returns true if CI passed, false if CI failed or timed out
 */
private async waitForPrCi(
  repository: Repository,
  branchName: string,
  timeoutMs: number = config.ciWaitTimeoutMs
): Promise<{ passed: boolean; status: BuildStatus }> {
  const connector = getConnector(repository.provider);
  const startTime = Date.now();
  let lastStatus: BuildStatus = { state: "unknown", checks: [] };

  while (Date.now() - startTime < timeoutMs) {
    try {
      lastStatus = await connector.getBuildStatus(repository, branchName);
    } catch (err) {
      console.warn(`[taskDispatcher] getBuildStatus error for branch ${branchName}:`, err);
      // Don't abort on transient API errors — keep polling
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      continue;
    }

    if (lastStatus.state === "success") {
      console.log(`[taskDispatcher] CI passed for branch ${branchName}`);
      return { passed: true, status: lastStatus };
    }

    if (lastStatus.state === "failure") {
      const failedChecks = lastStatus.checks
        .filter((c) => c.status === "failure")
        .map((c) => c.name)
        .join(", ");
      console.warn(
        `[taskDispatcher] CI failed for branch ${branchName}. Failing checks: ${failedChecks}`
      );
      return { passed: false, status: lastStatus };
    }

    if (lastStatus.state === "unknown" && lastStatus.checks.length === 0) {
      // No CI checks configured for this repo/branch — treat as passing
      console.log(
        `[taskDispatcher] No CI checks found for branch ${branchName} — assuming pass`
      );
      return { passed: true, status: lastStatus };
    }

    // state === "pending" — wait and retry
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `[taskDispatcher] CI pending for branch ${branchName} (${elapsed}s elapsed), waiting 30s...`
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  // Timeout
  console.warn(
    `[taskDispatcher] CI wait timeout after ${timeoutMs}ms for branch ${branchName}. Treating as failure.`
  );
  return { passed: false, status: lastStatus };
}
```

Note: Import `BuildStatus` from `../connectors/types` if not already imported.

---

## Task 3 — Call `waitForPrCi()` in `runTask()`

- [ ] In `runTask()`, find the section after the container exits successfully (after `waitForCompletion` returns `true` / after `updateAgentSession(sessionId, { status: "completed" })`)
- [ ] Insert the CI-aware completion block **before** any `createPr()` or final task status update call:

```typescript
// ── CI-aware completion ──────────────────────────────────────────────────────
if (config.waitForCi) {
  console.log(
    `[taskDispatcher] WAIT_FOR_CI=true — polling CI for branch ${branchName}`
  );

  const { passed, status: ciStatus } = await this.waitForPrCi(
    repository,
    branchName
  );

  // Record CI result in trace
  await this.recordCiResultInTrace(project, task, attemptNumber, passed, ciStatus);

  if (!passed) {
    // Mark task as failed — CI checks did not pass
    await updateTask(task.id, {
      status: "failed",
      errorMessage: `CI checks failed on branch ${branchName}: ${
        ciStatus.checks
          .filter((c) => c.status === "failure")
          .map((c) => c.name)
          .join(", ") || "timeout or unknown"
      }`,
    });
    throw new Error(
      `CI checks failed on agent branch ${branchName} — task marked failed`
    );
  }

  console.log(
    `[taskDispatcher] CI passed for branch ${branchName} — proceeding with PR`
  );
}
// ── End CI-aware completion ──────────────────────────────────────────────────
```

The exact insertion point depends on the current `runTask()` structure. The key invariant: **this block runs after container exit, before PR creation or task completion**.

---

## Task 4 — Add `recordCiResultInTrace()` method

- [ ] Add the following private method to `TaskDispatcher` (or as a module-level function):

```typescript
private async recordCiResultInTrace(
  project: Project,
  task: Task,
  attemptNumber: number,
  passed: boolean,
  status: BuildStatus
): Promise<void> {
  try {
    const trace = getOrCreateTrace(project.id, project.name);

    // TraceBuilder API: add a CI result event to the task's attempt
    // Adjust the method name to match TraceBuilder's actual API
    if (typeof trace.recordEvent === "function") {
      trace.recordEvent({
        type: "ci_result",
        taskId: task.id,
        attemptNumber,
        timestamp: new Date().toISOString(),
        data: {
          passed,
          state: status.state,
          checks: status.checks.map((c) => ({
            name: c.name,
            status: c.status,
            buildId: c.buildId,
          })),
        },
      });
    }

    await persistTrace(project, trace);
  } catch (err) {
    // Non-fatal — tracing failure should not abort the task
    console.warn("[taskDispatcher] Failed to record CI result in trace:", err);
  }
}
```

- [ ] Open `backend/src/orchestrator/traceBuilder.ts`
- [ ] If `recordEvent()` does not exist, add it (or use the existing event recording method):

```typescript
recordEvent(event: {
  type: string;
  taskId: string;
  attemptNumber: number;
  timestamp: string;
  data: Record<string, unknown>;
}): void {
  const attempt = this.getOrCreateAttempt(event.taskId, event.attemptNumber);
  attempt.events = attempt.events ?? [];
  attempt.events.push(event);
}
```

The `trace.json` schema for CI results will look like:
```json
{
  "taskId": "task-abc123",
  "attemptNumber": 1,
  "events": [
    {
      "type": "ci_result",
      "timestamp": "2026-03-28T10:15:00Z",
      "data": {
        "passed": false,
        "state": "failure",
        "checks": [
          { "name": "CI / test-backend", "status": "failure", "buildId": "99887766" }
        ]
      }
    }
  ]
}
```

- [ ] Run `bunx tsc --noEmit`

---

## Task 5 — Unit tests

- [ ] Create `backend/src/orchestrator/__tests__/taskDispatcher.ciAware.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the connector registry
vi.mock("../../connectors/registry", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "../../connectors/registry";

// Helper to create a mock connector with a scripted getBuildStatus sequence
function makeMockConnector(statuses: Array<{ state: string; checks: unknown[] }>) {
  let callCount = 0;
  return {
    getBuildStatus: vi.fn().mockImplementation(async () => {
      const result = statuses[Math.min(callCount, statuses.length - 1)];
      callCount++;
      return result;
    }),
  };
}

// Import the private method via a test-accessible wrapper
// (Adjust based on whether TaskDispatcher is a class or module)
import { TaskDispatcher } from "../taskDispatcher";

describe("TaskDispatcher.waitForPrCi", () => {
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    dispatcher = new TaskDispatcher();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns passed=true when CI is immediately successful", async () => {
    const mockConnector = makeMockConnector([
      { state: "success", checks: [{ name: "test", status: "success", buildId: "1", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mockConnector);

    const repo = { provider: "github", cloneUrl: "https://github.com/org/repo.git", providerConfig: {} } as any;
    // @ts-expect-error: accessing private method for test
    const result = await dispatcher.waitForPrCi(repo, "feature/test", 60_000);

    expect(result.passed).toBe(true);
    expect(result.status.state).toBe("success");
  });

  it("returns passed=false when CI immediately fails", async () => {
    const mockConnector = makeMockConnector([
      {
        state: "failure",
        checks: [{ name: "test-backend", status: "failure", buildId: "2", url: "" }],
      },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mockConnector);

    const repo = { provider: "github", cloneUrl: "https://github.com/org/repo.git", providerConfig: {} } as any;
    // @ts-expect-error
    const result = await dispatcher.waitForPrCi(repo, "feature/test", 60_000);

    expect(result.passed).toBe(false);
    expect(result.status.checks[0].name).toBe("test-backend");
  });

  it("polls until success after pending state", async () => {
    const mockConnector = makeMockConnector([
      { state: "pending", checks: [{ name: "test", status: "pending", buildId: "3", url: "" }] },
      { state: "pending", checks: [{ name: "test", status: "pending", buildId: "3", url: "" }] },
      { state: "success", checks: [{ name: "test", status: "success", buildId: "3", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mockConnector);

    const repo = { provider: "github", cloneUrl: "https://github.com/org/repo.git", providerConfig: {} } as any;

    // Run the polling with a short interval for tests
    // (In production this waits 30s; here we advance fake timers)
    const promise = (dispatcher as any).waitForPrCi(repo, "feature/test", 120_000);

    // Advance past two 30s waits
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;

    expect(result.passed).toBe(true);
    expect(mockConnector.getBuildStatus).toHaveBeenCalledTimes(3);
  });

  it("times out and returns passed=false", async () => {
    const mockConnector = makeMockConnector([
      { state: "pending", checks: [{ name: "test", status: "pending", buildId: "4", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mockConnector);

    const repo = { provider: "github", cloneUrl: "https://github.com/org/repo.git", providerConfig: {} } as any;

    const promise = (dispatcher as any).waitForPrCi(repo, "feature/test", 30_000);
    // Advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(result.passed).toBe(false);
  });

  it("treats unknown state with no checks as passing", async () => {
    const mockConnector = makeMockConnector([
      { state: "unknown", checks: [] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mockConnector);

    const repo = { provider: "github", cloneUrl: "https://github.com/org/repo.git", providerConfig: {} } as any;
    // @ts-expect-error
    const result = await dispatcher.waitForPrCi(repo, "feature/no-ci", 60_000);

    expect(result.passed).toBe(true);
  });
});
```

- [ ] Run: `cd backend && bun run test src/orchestrator/__tests__/taskDispatcher.ciAware.test.ts`

---

## Task 6 — Docker Compose and environment wiring

- [ ] Open `docker-compose.yml`
- [ ] Confirm the `backend` service exposes `WAIT_FOR_CI` and `CI_WAIT_TIMEOUT_MS`:

```yaml
  backend:
    environment:
      WAIT_FOR_CI: ${WAIT_FOR_CI:-false}
      CI_WAIT_TIMEOUT_MS: ${CI_WAIT_TIMEOUT_MS:-600000}
      # ... other existing env vars ...
```

- [ ] For Kubernetes (if using Helm chart), add to `charts/multi-agent-harness/values.yaml`:

```yaml
backend:
  env:
    WAIT_FOR_CI: "false"
    CI_WAIT_TIMEOUT_MS: "600000"
```

And reference in the Deployment template:
```yaml
- name: WAIT_FOR_CI
  value: {{ .Values.backend.env.WAIT_FOR_CI | quote }}
- name: CI_WAIT_TIMEOUT_MS
  value: {{ .Values.backend.env.CI_WAIT_TIMEOUT_MS | quote }}
```

- [ ] Commit: `feat: add WAIT_FOR_CI flag to taskDispatcher with CI polling and trace recording`

---

## Verification checklist

- [ ] `bunx tsc --noEmit` passes with no errors
- [ ] All 5 unit tests pass
- [ ] `WAIT_FOR_CI=false` (default): `runTask()` behaves exactly as before — no polling, no delay
- [ ] `WAIT_FOR_CI=true`: task waits for CI before marking complete
- [ ] `WAIT_FOR_CI=true` + CI success: task completes normally, CI result recorded in trace.json
- [ ] `WAIT_FOR_CI=true` + CI failure: task marked as `failed` with error message naming failing checks
- [ ] `WAIT_FOR_CI=true` + timeout: task marked as `failed` with timeout message
- [ ] `WAIT_FOR_CI=true` + no CI checks (unknown + empty): task passes through as if CI succeeded
- [ ] CI result appears in `trace.json` under the task's attempt events with `type: "ci_result"`
- [ ] Docker Compose passes `WAIT_FOR_CI` and `CI_WAIT_TIMEOUT_MS` from host environment
- [ ] Polling interval is 30 seconds; does not hammer the VCS API
- [ ] Transient `getBuildStatus` API errors (network timeouts, 5xx) do not abort the polling loop — they log a warning and retry
