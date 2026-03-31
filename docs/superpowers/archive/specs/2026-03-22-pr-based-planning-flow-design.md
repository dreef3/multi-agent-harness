# PR-Based Planning Flow Design

**Date:** 2026-03-22
**Status:** Draft

---

## Overview

Replace the current in-UI plan approval flow with a GitHub/Bitbucket PR-based workflow that mirrors the superpowers brainstorm → spec → plan cycle. The master agent brainstorms with the user, writes a design spec and implementation plan as Markdown files to a planning branch, and opens a single PR in the project's primary repository. Two LGTM comment gates control progression: spec approval triggers plan writing; plan approval triggers sub-agent execution. The chat window remains the notification surface throughout.

---

## Motivation

The current flow parses a plan from the master agent's text output, which is fragile for large documents and loses the natural spec/plan separation. Moving the review surface to GitHub/Bitbucket gives users familiar tooling (comments, diff views, edit suggestions) for reviewing and refining planning documents before implementation begins.

---

## State Machine

```
brainstorming
  │  User chats; master asks clarifying questions
  ▼
spec_in_progress
  │  Master writes spec via tool → backend opens PR → master posts link in chat
  ▼
awaiting_spec_approval
  │  Backend polls planning PR for LGTM comment
  │  On LGTM: backend resumes master session with [SYSTEM] approval message
  ▼
plan_in_progress
  │  Master writes plan via tool → backend commits to same PR → master posts link
  ▼
awaiting_plan_approval
  │  Backend polls planning PR for second LGTM comment
  │  On LGTM: backend resumes master → master notifies user → sub-agents dispatched
  ▼
executing → completed / failed / cancelled
```

The existing `awaiting_approval` status is removed.

**Migration:** Any in-flight project in `awaiting_approval` at deploy time is moved to `failed` via a one-time DB migration script. Users must recreate those projects. The `POST /projects/:id/approve` REST endpoint is removed. The `/projects/:id/plan` UI route redirects to the project's chat page.

---

## Branch & PR Structure

### Primary Repository

Each project designates a **primary repository** (user-selected at project creation; auto-selected when only one repo is attached). Primary repository is **immutable** after creation. A project must have at least one repository — creation is rejected if `repositoryIds` is empty.

- **Branch:** `harness/{prefix}{slug}-{suffix}` — human-readable, uniqueness guaranteed by a 5-character alphanumeric suffix derived from the projectId (first 5 chars of the UUID, lowercased, non-alphanumeric stripped)
  - `{prefix}`: issue/ticket reference if available — `issue-{n}-` for GitHub issues (e.g. `issue-42-`), `{TICKET}-` for Jira (e.g. `PROJ-123-`), empty for freeform
  - `{slug}`: project name slug (same sanitization rules as file paths below), truncated to 30 characters
  - Examples: `harness/issue-42-add-user-auth-a3b2c`, `harness/PROJ-123-migrate-db-f9e1a`, `harness/refactor-payments-7c4d2`
- **PR:** Opened once at spec phase, never closed by the system
- **PR title:** `[Harness] {project name}`
- **PR body:** Link back to the harness UI project page
- **Merge tracking:** The system does not track whether the PR is merged. That is the user's responsibility.

### File Paths

`{date}` is the UTC date at project creation in `YYYY-MM-DD` format. `{slug}` is the project name sanitized: lowercase, replace spaces with hyphens, strip all characters that are not alphanumeric or hyphens, collapse consecutive hyphens, truncate to 50 characters. If the slug is empty after sanitization, use `project`.

Since each branch is unique to one project (UUID in branch name), file paths within the branch cannot collide across projects.

| Document | Path |
|----------|------|
| Design spec | `docs/superpowers/specs/{date}-{slug}-design.md` |
| Implementation plan | `docs/superpowers/plans/{date}-{slug}-plan.md` |

Both committed to `harness/{projectId}` branch. The plan is a second commit to the same open PR.

### Other Repositories

For multi-repo projects, non-primary repo branches are created at **execution time** (when plan LGTM is received). Each gets:

- **Branch:** same name as primary repo branch (`harness/{prefix}{slug}-{suffix}`), created in each additional repo
- `docs/superpowers/plans/{date}-{slug}-plan.md` committed with the **full plan** (not filtered per repo)
- Sub-agents receive their specific task via `TASK_DESCRIPTION` env var (authoritative). The plan file is present on-branch for additional context.

_Filtering plan content per repo is deferred to a future iteration._

---

## Custom Tool: `write_planning_document`

The tool is injected via the confirmed `customTools: ToolDefinition[]` parameter of `createAgentSession()` in `@mariozechner/pi-coding-agent`. The `execute()` function is a server-side callback that closes over the project's handler function. Parameters use TypeBox schema.

```typescript
// Tool definition (TypeBox schema)
{
  name: "write_planning_document",
  label: "Write Planning Document",
  description: `Write a planning document to the project's planning branch in the
    primary repository. Call with type "spec" first to write the design spec and open
    the PR. Call with type "plan" after spec is approved to write the implementation
    plan. Returns the PR URL.`,
  parameters: Type.Object({
    type: Type.Union([Type.Literal("spec"), Type.Literal("plan")]),
    content: Type.String({ description: "Full Markdown content" })
  }),
  async execute(toolCallId, { type, content }, signal, onUpdate, ctx) {
    const result = await handleWritePlanningDocument(projectId, type, content);
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
  }
}
```

The `handleWritePlanningDocument` function is implemented in the backend and passed in via closure when `MasterAgent.init()` creates the session.

### Backend Handler Behaviour

**Idempotency:** The handler checks for an existing branch and PR before creating them. If the branch already exists it is reused. If a PR for the branch is already open it is reused. This makes the tool safe to retry on partial VCS failure.

**For `type: "spec"`:**
1. Creates branch `harness/{projectId}` in primary repo via the updated `VcsConnector.commitFile()` (see VCS Changes below). If branch already exists, skips branch creation.
2. Commits content to `docs/superpowers/specs/{date}-{slug}-design.md`
3. Opens PR titled `[Harness] {project name}` with body linking to harness UI. If PR already open for this branch, reuses it.
4. Stores `planningBranch` and `planningPr` on project record
5. Updates project status → `awaiting_spec_approval`
6. Returns `{ prUrl: string }`

**For `type: "plan"`:**
1. Validates that project has `planningBranch` and `planningPr`. Returns an error string to the agent if not.
2. Commits content to `docs/superpowers/plans/{date}-{slug}-plan.md` on the existing branch
3. Updates project status → `awaiting_plan_approval`
4. Returns `{ prUrl: string }` (same PR URL as spec)

### Error Handling

| Failure | Behaviour |
|---------|-----------|
| VCS API error during branch/commit/PR | Tool returns descriptive error to agent; project stays in `spec_in_progress` / `plan_in_progress`; agent notifies user in chat |
| `type: "plan"` called before spec is written | Tool returns error: "Spec must be written first" |
| PR closed by user before plan LGTM | Polling detects closed PR; project → `failed`; master receives `[SYSTEM]` message (see below) |

---

## VCS Connector Changes

A new method is added to the `VcsConnector` interface:

```typescript
commitFile(
  branch: string,           // branch to commit to (create if not exists)
  path: string,             // file path within repo
  content: string,          // file content (UTF-8)
  message: string,          // commit message
  createBranch?: boolean    // if true, create branch from defaultBranch first
): Promise<void>
```

Implemented for both `GitHubConnector` and `BitbucketConnector`. For GitHub this uses the Contents API (get ref SHA → create blob → create tree → create commit → update ref). For Bitbucket Server this uses the Files API. Commit author identity is configurable via `GIT_COMMIT_AUTHOR_NAME` / `GIT_COMMIT_AUTHOR_EMAIL` env vars (default: `Harness Bot` / `harness@noreply`).

---

## LGTM Detection & Polling

### New Polling Path

The existing `polling.ts` polling loop only covers Bitbucket Server review comments. A **new polling path** is added that handles LGTM detection for both GitHub and Bitbucket Server on planning PRs. This is separate from the existing review comment polling and routes to the agent rather than the debounce engine.

The polling loop queries for all projects in `awaiting_spec_approval` or `awaiting_plan_approval` status. For each, it calls `VcsConnector.getComments(planningPr.number)` on the primary repository, checks for any comment containing `LGTM` as a standalone string (case-insensitive regex: `/\bLGTM\b/i`), and compares against the last seen comment timestamp stored on the project.

**GitHub:** The existing `GitHubConnector` already has a `getComments` method (used for PR review comments on implementation PRs). The same method is reused here, pointing at the planning PR number.

**Bitbucket Server:** Same as GitHub — existing `getComments` is reused.

Polling interval: every 30 seconds, integrated into the existing polling scheduler.

### Planning PR Tracking

The planning PR is tracked **only** via the `planningPr` field on the `Project` record (not inserted into the `pull_requests` table, which has a non-nullable `agent_session_id` and is scoped to implementation PRs). The LGTM polling loop queries projects directly by status, not via `pull_requests`.

### [SYSTEM] Messages Injected into Master Session

**Spec approved:**
```
[SYSTEM] The spec has been approved (LGTM received on the PR).
Write the implementation plan now using the write_planning_document tool with type "plan".
Then post the PR URL in chat and tell the user to add a LGTM comment when ready to start implementation.
```

**Plan approved:**
```
[SYSTEM] The implementation plan has been approved (LGTM received on the PR).
Tell the user that implementation is starting and the sub-agents will take it from here.
```

**PR closed before approval:**
```
[SYSTEM] The planning PR was closed before approval. The project has been marked as failed. Let the user know.
```

### Resuming the Master Session from the Polling Context

When LGTM is detected, the polling handler calls `getOrInitAgent(projectId)` (already exported from `websocket.ts`) to obtain the `MasterAgent` instance. This function handles both the case where the session is already in memory and the case where it must be restored from `data/sessions/{projectId}/master.jsonl`. The polling module imports `getOrInitAgent` from `websocket.ts` — this is a one-directional dependency (polling → websocket), introducing no circular dependency.

After obtaining the agent, the handler calls `agent.prompt("[SYSTEM] ...")`. Any connected WebSocket clients will receive the resulting delta events as normal.

---

## Task Dispatch After Plan Approval

When plan LGTM is received:

1. Parse tasks from `plan.md` content using the existing `parsePlan()` function (same `### Task N:` format)
2. Store parsed tasks on `project.plan.tasks` (same location as today)
3. Set `project.planningPr.planApprovedAt`
4. Update project status → `executing`
5. Call `TaskDispatcher.dispatchTasks(docker, projectId)`

`TaskDispatcher.dispatchTasks()` is updated: instead of checking `project.plan.approved`, it checks that `project.planningPr?.planApprovedAt` is set. `plan.approved` and `plan.approvedAt` are removed from the `Plan` type.

---

## Master Agent Session Continuity

The master agent session is long-lived and per-project. Sessions are stored in `data/sessions/{projectId}/master.jsonl`. When `getOrInitAgent` is called for a project with an existing session file, `SessionManager` restores the session from the file rather than starting fresh.

During `awaiting_*_approval` states the session is idle. Incoming user WebSocket messages are forwarded to the agent normally — the user may ask questions or request edits while waiting for approval.

---

## Data Model Changes

### New Project Fields (stored as columns on `projects` table)

```typescript
primaryRepositoryId: string;   // immutable after creation; new NOT NULL column
planningBranch: string;        // e.g. "harness/issue-42-add-user-auth-a3b2c", set when spec tool is called; nullable column
planningPr: {                  // stored as JSON column `planning_pr_json`
  number: number;
  url: string;
  specApprovedAt?: string;     // ISO timestamp
  planApprovedAt?: string;     // ISO timestamp
} | null;
```

### DB Migration

SQL migration applied at startup:

```sql
ALTER TABLE projects ADD COLUMN primary_repository_id TEXT;
ALTER TABLE projects ADD COLUMN planning_branch TEXT;
ALTER TABLE projects ADD COLUMN planning_pr_json TEXT;

-- Migrate existing projects: set primary_repository_id to first repositoryId
UPDATE projects
SET primary_repository_id = json_extract(repository_ids_json, '$[0]')
WHERE primary_repository_id IS NULL AND json_array_length(repository_ids_json) > 0;

-- Move awaiting_approval projects to failed
UPDATE projects SET status = 'failed' WHERE status = 'awaiting_approval';
```

`plan.approved` and `plan.approvedAt` are removed from the `plan_json` TypeScript type; existing rows with those keys are ignored (no cleanup needed — `plan_json` is opaque TEXT).

### Project Status Values

| Status | Meaning |
|--------|---------|
| `brainstorming` | Unchanged |
| `spec_in_progress` | **New** — master is writing the spec |
| `awaiting_spec_approval` | **New** — waiting for LGTM on spec |
| `plan_in_progress` | **New** — master is writing the plan |
| `awaiting_plan_approval` | **New** — waiting for LGTM on plan |
| `executing` | Unchanged |
| `completed` | Unchanged |
| `failed` | Unchanged |
| `cancelled` | Unchanged |
| ~~`awaiting_approval`~~ | **Removed** |

---

## Master Agent System Prompt

`buildMasterAgentContext()` in `websocket.ts` is updated with two-phase instructions:

```
## Your Role
You are a master planning agent. You operate in two phases, each driven by a
dedicated superpowers skill. Follow each skill's process exactly.

---

## Phase 1 — Design Spec

Invoke the `superpowers:brainstorming` skill. Follow its full process:

1. Explore the project context (repositories, existing code, recent commits).
2. Ask clarifying questions one at a time (multiple-choice preferred).
3. Propose 2–3 design approaches with trade-offs and a recommendation.
4. Present the design in sections; get approval after each section.
5. Write the spec to:
   `docs/superpowers/specs/{YYYY-MM-DD}-{project-slug}-design.md`
6. Dispatch the `spec-document-reviewer` subagent (from the brainstorming skill's
   `spec-document-reviewer-prompt.md`). Fix any issues and re-dispatch until
   approved (max 3 iterations; surface to user if still failing after 3).
7. Ask the user to review the written spec file before proceeding.
8. Once the user approves the written spec, call:
   `write_planning_document(type: "spec", content: <full spec markdown>)`
9. After the tool returns, post the PR URL in chat:
   "The spec is ready for review at {url}. Add a LGTM comment to the PR when you
   are happy with it."

---

## Phase 2 — Implementation Plan

Triggered when you receive:
`[SYSTEM] The spec has been approved (LGTM received on the PR).`

Invoke the `superpowers:writing-plans` skill. Follow its full process:

1. Re-read the approved spec carefully.
2. Define the file structure and task boundaries.
3. Write a detailed plan with bite-sized tasks (2–5 min each), each containing:
   - Files to create/modify/test
   - Exact code snippets
   - Exact commands with expected output
   - Step-by-step checkboxes
4. Save the plan to:
   `docs/superpowers/plans/{YYYY-MM-DD}-{project-slug}-plan.md`
   Include this header for the sub-agents that will execute it:
   > **For agentic workers:** Tasks will be executed by containerised sub-agents.
   > Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.
5. Dispatch the `plan-document-reviewer` subagent (from the writing-plans skill's
   `plan-document-reviewer-prompt.md`). Fix issues and re-dispatch until approved
   (max 3 iterations).
6. Ask the user to review the written plan file before proceeding.
7. Once the user approves the written plan, call:
   `write_planning_document(type: "plan", content: <full plan markdown>)`
8. After the tool returns, post the PR URL in chat:
   "The implementation plan is ready for review at {url}. Add a LGTM comment when
   you are ready to start implementation."

**Important:** The `writing-plans` skill normally ends by asking the user to choose
between subagent-driven or inline execution. **Skip that step entirely.** In this
harness, execution is handled automatically by containerised Docker sub-agents after
the plan LGTM is received. Do not ask about worktrees or execution modes.

The plan must use this task format exactly (used by the task parser):

### Task 1: [Brief Task Title]
**Repository:** [exact repository name from the list above]
**Description:**
[Detailed description — self-contained enough for a sub-agent with no other context]

### Task 2: ...

---

## Phase 3 — Implementation Started

Triggered when you receive:
`[SYSTEM] The implementation plan has been approved (LGTM received on the PR).`

Tell the user:
"The plan has been approved. Implementation is starting — the sub-agents will take
it from here. I'll let you know when they're done."

Do NOT invoke any execution skill. Sub-agent execution is handled automatically
by the harness.

---

## Important Rules
- Do NOT make code changes yourself at any point.
- Do NOT skip the spec-document-reviewer or plan-document-reviewer subagent steps.
- Communicate every state transition explicitly in chat.
- Follow superpowers skill processes exactly — do not shortcut them.
```

---

## Sub-Agent Task Prompt

Sub-agents currently receive only `TASK_DESCRIPTION` with no system prompt and superpowers skills disabled in the runner. To give them structured guidance, `TaskDispatcher` prepends a **workflow preamble** to every `TASK_DESCRIPTION` before passing it to the container. The preamble encodes the key superpowers skill behaviors inline so no skill loading is required.

### Preamble Template

```
You are a software engineering sub-agent. Follow this workflow exactly.

## Step 1 — Understand the Task
Read the task description below carefully. If a plan file exists in the repository
at docs/superpowers/plans/, read it to understand the full project context before
starting.

## Step 2 — Test-Driven Development (superpowers:test-driven-development)
Follow strict TDD. For every behaviour you implement:
1. Write a failing test first. Run it and confirm it fails for the right reason.
2. Write the minimum code to make it pass. Run it and confirm it passes.
3. Refactor. Keep tests green.
Never write production code without a failing test first. If you find yourself
writing implementation before a test, stop and write the test first.

## Step 3 — Implement
Work through the task description step by step. Commit logical units of work with
clear messages. Do not make changes beyond the scope of the task.

## Step 4 — Systematic Debugging (superpowers:systematic-debugging)
If you encounter a bug or unexpected behaviour:
1. Reproduce it reliably first.
2. Form a hypothesis about the root cause.
3. Test the hypothesis before attempting a fix.
4. Fix only after confirming the root cause.
Never guess-and-check. Root cause first, always.

## Step 5 — Verify Before Finishing (superpowers:verification-before-completion)
Before considering the task done:
1. Run the full test suite. Show the command and its output.
2. Confirm every acceptance criterion in the task description is met.
3. Do not claim completion without fresh evidence. "Should work" is not evidence.
If verification fails, go back and fix — do not push broken code.

## Step 6 — Commit and Push
Stage and commit all changes. The harness will open the pull request automatically.

---

## Your Task

{TASK_DESCRIPTION}
```

### Implementation Note

`TaskDispatcher.buildTaskPrompt(task)` is introduced as a helper that returns the preamble with `{TASK_DESCRIPTION}` replaced by `task.description`. The container manager passes the result of this function as the `TASK_DESCRIPTION` env var.

---

## Observability: Log Commits to Git

Both master and sub-agent execution logs must be committed to the planning branch so they are visible alongside the spec, plan, and implementation — and available for troubleshooting even when an agent fails midway.

### Log Locations (on planning branch)

```
.harness/
  logs/
    master/
      session.jsonl          # full pi-coding-agent session transcript
    sub-agents/
      {taskId}/
        session.jsonl        # pi-coding-agent session transcript
        task-output.md       # human-readable summary (already exists)
```

Logs are committed to the **planning branch** (`harness/{prefix}{slug}-{suffix}`) in the primary repo. For sub-agents on non-primary repos, logs are committed to their respective branch (`harness/{prefix}{slug}-{suffix}` in that repo).

### Sub-Agent Log Commit

`runner.mjs` is updated to commit the session log **unconditionally** at exit, regardless of success or failure:

1. After `session.prompt()` resolves or rejects, locate the session JSONL file written by pi-coding-agent (in the agent's working directory / session path)
2. Copy it to `.harness/logs/sub-agents/{taskId}/session.jsonl`
3. Stage and commit with message: `chore: add agent log for task {taskId}`
4. Push to the branch
5. Exit with original exit code (failure is preserved for the harness to detect)

If the push fails (e.g. network error), log to stdout and continue — log preservation is best-effort.

### Master Agent Log Commit

The backend commits the master session log at each major state transition:

| Trigger | Committed to |
|---------|-------------|
| `write_planning_document(type: "spec")` called | `.harness/logs/master/session.jsonl` (first commit) |
| `write_planning_document(type: "plan")` called | `.harness/logs/master/session.jsonl` (update commit) |
| Project reaches `executing`, `failed`, or `cancelled` | `.harness/logs/master/session.jsonl` (final commit) |

The master session file is already written by pi-coding-agent to `data/sessions/{projectId}/master.jsonl`. The `write_planning_document` tool handler reads this file and commits it as part of the same VCS operation that commits the spec/plan file.

---

## Frontend Changes

### Removed
- `PlanApproval.tsx` page; route `/projects/:id/plan` redirects to `/projects/:id/chat`
- `plan_ready` WebSocket event handling and navigation in `Chat.tsx`
- `POST /api/projects/:id/approve` REST endpoint

### Modified

**`NewProject.tsx`**
- Add **Primary Repository** selector rendered below the repository multi-select
- Hidden and auto-populated when exactly one repo is selected; visible as a dropdown when two or more repos are selected
- Project creation fails with a 400 if no repositories are selected

**`Dashboard.tsx`** — new status badges:

| Status | Label | Colour |
|--------|-------|--------|
| `spec_in_progress` | "Writing Spec" | Blue |
| `awaiting_spec_approval` | "Awaiting Spec Approval" | Amber |
| `plan_in_progress` | "Writing Plan" | Blue |
| `awaiting_plan_approval` | "Awaiting Plan Approval" | Amber |

**`Chat.tsx`**
- Remove `plan_ready` WebSocket event handler and `navigate` to plan page
- PR links appear as regular agent messages — no special handling needed

**`api.ts`**
- Remove `projects.approve` method
- Add `primaryRepositoryId` to `CreateProjectRequest` type

### Unchanged
- `PrOverview.tsx`, `Execution.tsx`, WebSocket delta streaming, message history/replay

---

## Open Questions

1. **Commit author identity** — what git author name/email to use for spec/plan commits. Proposed: configurable via `GIT_COMMIT_AUTHOR_NAME` / `GIT_COMMIT_AUTHOR_EMAIL` env vars, defaulting to `Harness Bot` / `harness@noreply`.
