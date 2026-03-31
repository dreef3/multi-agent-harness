# Enterprise: Agent Traceability & Audit Trail

## Current State

Agent work products are scattered across three disconnected stores:

1. **Repository-committed files** — Sub-agents commit `.harness/logs/sub-agents/{TASK_ID}/session.jsonl` and `task-output.md` to task branches. Planning agent commits `.harness/logs/master/session.jsonl` and `.harness/logs/planning-agent/{projectId}.jsonl` via the VCS connector.
2. **SQLite tables** — `agent_events` stores tool calls/results per session. `messages` stores chat history.
3. **Execution tab UI** — Real-time WebSocket stream of agent activity, rendered in the browser.

### Problems

- **No requirement-to-code traceability**: There is no structured link between a spec requirement, a plan task, a sub-agent session, and the resulting commits. Reviewers cannot answer "why does this code exist?" from the artifacts alone.
- **Repository clutter**: Raw `.jsonl` session dumps and `task-output.md` files are committed to every task branch. These are verbose (1000+ lines), not human-readable, and pollute git history.
- **Inconsistent data**: The three stores are not synchronized. The SQLite data is ephemeral (lost if the harness is restarted without backup). The repository files are incomplete (no planning agent context, no retry history).
- **No tamper protection**: Agents themselves write the `.harness/` files. A misbehaving agent could modify or delete its own audit trail.
- **Doesn't scale for enterprise**: Multiple squads reviewing agent work across projects need a consistent, structured, human-readable format — not raw JSONL dumps.

## Target State

A single, structured `.harness/trace.json` file per project branch that provides end-to-end traceability from requirements through agent work to code changes. The backend exclusively owns this file — agents cannot read or modify it.

---

## 1. Trace File Design

### Location and Ownership

- **Path**: `.harness/trace.json` on the project's planning branch
- **Owner**: Backend only. Committed via VCS connector (`commitFile()` API).
- **Agents**: Both planning agent and sub-agent are blocked from reading or writing any path under `.harness/` (enforced by guard hooks in both runners).

### Schema (v1.0)

```json
{
  "version": "1.0",
  "project": {
    "id": "uuid",
    "name": "Project name",
    "createdAt": "2026-03-28T10:00:00Z",
    "createdBy": "user@corp.example.com",
    "specPrUrl": "https://github.com/org/repo/pull/42",
    "specApprovedAt": "2026-03-28T11:00:00Z",
    "planApprovedAt": "2026-03-28T12:00:00Z",
    "completedAt": "2026-03-28T18:00:00Z",
    "status": "completed",
    "specApprovedBy": "tl@corp.example.com",
    "planApprovedBy": "tl@corp.example.com"
  },
  "requirements": [
    {
      "id": "req-1",
      "summary": "Add user authentication via OIDC",
      "section": "Spec §2.1 — Authentication"
    }
  ],
  "tasks": [
    {
      "id": "sha256-stable-task-id",
      "name": "implement-auth-middleware",
      "requirementIds": ["req-1"],
      "planSection": "Plan §3.2 — Auth Middleware",
      "status": "completed",
      "branch": "task/implement-auth-middleware",
      "attempts": [
        {
          "attempt": 1,
          "sessionId": "uuid",
          "startedAt": "2026-03-28T13:00:00Z",
          "completedAt": "2026-03-28T14:30:00Z",
          "exitCode": 0,
          "agent": {
            "provider": "anthropic",
            "model": "claude-sonnet-4-20250514"
          },
          "toolCalls": [
            {
              "tool": "Edit",
              "file": "src/middleware/auth.ts",
              "timestamp": "2026-03-28T13:05:00Z"
            },
            {
              "tool": "Bash",
              "command": "npm test",
              "exitCode": 0,
              "timestamp": "2026-03-28T13:20:00Z"
            },
            {
              "tool": "Write",
              "file": "src/middleware/auth.test.ts",
              "timestamp": "2026-03-28T13:10:00Z"
            }
          ],
          "commits": [
            {
              "sha": "abc123def456",
              "message": "feat: add OIDC auth middleware"
            }
          ],
          "filesChanged": [
            "src/middleware/auth.ts",
            "src/middleware/auth.test.ts"
          ],
          "ci": {
            "state": "success",
            "checks": [
              { "name": "test-backend", "status": "success" },
              { "name": "test-frontend", "status": "success" }
            ],
            "checkedAt": "2026-03-28T14:45:00Z"
          }
        }
      ]
    }
  ],
  "planningPr": {
    "url": "https://github.com/org/repo/pull/42",
    "branch": "project/auth-system",
    "status": "open"
  },
  "pullRequests": [
    {
      "id": "uuid",
      "url": "https://github.com/org/repo/pull/43",
      "branch": "task/implement-auth-middleware",
      "taskIds": ["sha256-stable-task-id"],
      "status": "open"
    }
  ]
}
```

### Schema Design Decisions

- **`project.status`**: One of `brainstorming`, `spec_in_progress`, `awaiting_spec_approval`, `plan_in_progress`, `awaiting_plan_approval`, `executing`, `completed`, `failed`, `cancelled`. Matches the project lifecycle state machine in `models/types.ts`.
- **`project.specApprovedBy` / `planApprovedBy`**: The email of the user who submitted the PR approval. Populated from the VCS review author when approval is detected by the polling loop via the VCS connector's PR review API. In local mode (no auth), set to `"local-user"`.
- **`requirements` array**: Extracted from the spec document when the planning agent writes it via `write_planning_document`. The backend parses the spec markdown using a simple heuristic: top-level numbered items or `##`/`###` headings under sections named "Requirements", "Features", or "Functional Requirements". Each extracted item gets `id` (sequential `req-N`), `summary` (first sentence or heading text), and `section` (the full heading path, e.g., "Requirements > Authentication > OIDC"). If the spec has no parseable structure, the array is empty — this is acceptable; traceability still works at the task level.
- **`tasks[].id`**: Either a SHA-256 hash (from `dispatch_tasks` stable ID generation: `sha256(repoId + ':' + description)`) or a UUID (from manual task creation via API). Both formats are valid; the trace file does not normalize them.
- **`tasks[].status`**: One of `pending`, `running`, `completed`, `failed`. Derived from the latest attempt: `running` if the last attempt has no `completedAt`, `completed` if last attempt has `exitCode === 0`, `failed` if last attempt has `exitCode !== 0`, `pending` if no attempts exist.
- **`tasks[].requirementIds`**: Links each task back to one or more requirements. The planning agent provides this mapping when calling `dispatch_tasks` via an optional `requirementIds` field per task. If omitted, defaults to an empty array (no requirement link). Text-matching fallback is not used — explicit mapping or nothing.
- **`tasks[].attempts`**: Array supports retries. Each attempt is a complete record of one agent session. Failed attempts (exitCode != 0) are preserved for audit.
- **`toolCalls`**: Condensed — tool name, key parameter, exit code for Bash, and timestamp. The key parameter is extracted from `agent_events` payload by tool type: `Edit`/`Write`/`Read` → `file` (from `file_path`), `Bash` → `command` (from `command`), `Glob`/`Grep` → `file` (from `pattern`). Tools without a file or command field get the tool name only. No full input/output payloads.
- **`commits`**: SHA and message only. Full diffs are in git history.
- **`planningPr`**: The spec/plan PR. Included for completeness — links the trace back to the planning branch.
- **`pullRequests[].taskIds`**: Links implementation PRs back to tasks. The mapping is derived from the `agent_sessions` table: each session has a `task_id`, and each PR has an `agent_session_id`. The backend joins through sessions to resolve task IDs at trace-write time. Implementation note: a `task_id` column should be added to the `pull_requests` table for direct lookup.

### Size Estimate

A typical task with 20-50 tool calls, 2-3 commits, one attempt: ~2-4 KB of JSON. A project with 10 tasks: ~30-50 KB. Retries add ~2-4 KB per additional attempt. This is orders of magnitude smaller than raw JSONL session dumps (often 100+ KB per task).

---

## 2. Lifecycle: When trace.json Is Updated

The trace file is updated at each state transition in the project lifecycle, committed via the VCS connector's `commitFile()` API.

**Note**: Requirements are extracted earlier — when the spec is written via `write_planning_document(type: "spec")` — and stored on the project record. They are included in the initial `trace.json` at plan approval time.

| Event | What Changes | Trigger Location |
|-------|-------------|-----------------|
| **Plan approved** (project enters `executing`) | File created with `project` (incl. approver identity), `requirements` (from project record), `planningPr`, and `tasks` stubs (from plan) | `polling.ts` — PR approval detection for plan approval |
| **Task dispatched** | Task entry updated with `startedAt`, `agent` config | `taskDispatcher.ts` — `runTask()` |
| **Task completed** | Attempt entry appended with `toolCalls`, `commits`, `filesChanged`, `exitCode` | `taskDispatcher.ts` — `waitForCompletion()` resolution |
| **PR created** | `pullRequests` array entry added | `taskDispatcher.ts` — after PR creation step |
| **Fix run completed** | New attempt appended to the relevant task | `taskDispatcher.ts` — `runFixRun()` completion |
| **Project completed** | `project.completedAt` and `project.status` updated | `polling.ts` or `recoveryService.ts` — `checkAllTerminal()` |

### Update Mechanics

Each update follows the same pattern:

1. Backend reads current `trace.json` from the branch via VCS connector (or initializes a new one)
2. Merges the new data into the JSON structure
3. Commits the updated file via `commitFile()`

Conflict risk is low: the per-project semaphore (`MAX_IMPL_AGENTS_PER_PROJECT=1`) ensures only one task executes at a time per project. The backend is the sole writer. However, planning-level events (plan approved, project completed) could overlap with task-level events. The `TraceBuilder` module must serialize writes per project — use a per-project mutex (or queue) to ensure only one `commitFile()` call is in flight at a time for a given project's trace file.

### Data Sources for Trace Entries

| Trace field | Source |
|-------------|--------|
| `project.*` | `projects` SQLite table |
| `requirements` | Parsed from spec markdown (stored on project record) |
| `tasks[].id`, `name`, `planSection` | `PlanTask` records from plan parsing |
| `tasks[].requirementIds` | Mapping from `dispatch_tasks` call (planning agent provides this) |
| `tasks[].attempts[].toolCalls` | `agent_events` SQLite table (filtered: `type='tool_call'`) |
| `tasks[].attempts[].commits` | Parsed from container output or git log on branch after task completion |
| `tasks[].attempts[].filesChanged` | Git diff between branch state before and after task |
| `tasks[].attempts[].ci` | VCS connector `getBuildStatus()` — polled after task completion (see `enterprise-cicd.md` §6) |
| `pullRequests` | `pull_requests` SQLite table |

---

## 3. Agent Guard Hook

Both agent runners (`planning-agent/runner.mjs` and `sub-agent/runner.mjs`) already implement a `BashSpawnHook` that blocks destructive operations (force push, `gh pr create`, `curl`, `wget`). The `.harness/` guard extends this pattern.

### Implementation

**Bash command guard** — Add to both runners' `BashSpawnHook`. The guard blocks multiple evasion vectors (glob patterns, variable expansion, directory traversal):

```javascript
// Block any Bash command that could access .harness/ directory
// Covers: direct path, glob evasion (.h*rness), cd into directory
const harnessPaths = ['.harness', '.h*rness', '.h?rness'];
const lowerCommand = command.toLowerCase();
if (harnessPaths.some(p => lowerCommand.includes(p)) || /cd\s+.*\.harness/.test(command)) {
  return { decision: "block", reason: ".harness/ is managed by the harness backend — agents cannot read or modify it" };
}
```

**File tool guard** — Block file tool access (Edit, Write, Read, Glob, Grep) to `.harness/` paths. This must be implemented using the pi-coding-agent extension system's tool hook mechanism. **Implementation note**: Verify that the `pi-coding-agent` session API supports a `beforeToolCall` hook or equivalent file-path filter. If not, the guard must be implemented via the `systemPrompt` instruction (less secure but functional) combined with a post-hoc audit check that flags any `.harness/` access in `agent_events`.

```javascript
// File tool guard — applied via session extension or tool wrapper
function blockHarnessAccess(toolName, args) {
  const filePath = args.file_path || args.path || args.pattern || "";
  if (filePath.includes(".harness/") || filePath.includes(".harness\\")) {
    return { blocked: true, reason: ".harness/ is managed by the harness backend" };
  }
}
```

The Bash guard is the primary defense; the file tool guard is defense-in-depth. Both are required.

### Migration: Remove Current .harness/ Commits from Agents

The following code currently commits `.harness/` files from agents and must be removed:

| File | Lines | Current Behavior | Change |
|------|-------|-----------------|--------|
| `sub-agent/runner.mjs` | ~247, ~271 | Commits `session.jsonl` and `task-output.md` to branch | Remove — backend writes `trace.json` instead |
| `backend/src/agents/planningTool.ts` | ~122, ~180 | Commits session log snapshots via VCS connector | Remove — backend writes `trace.json` instead |
| `backend/src/orchestrator/planningAgentManager.ts` | ~699 | Commits planning agent session logs | Remove — backend writes `trace.json` instead |

---

## 4. Requirements Extraction

When the planning agent calls `write_planning_document` with `type: "spec"`, the backend receives the spec markdown. To populate the `requirements` array in `trace.json`:

1. Parse the spec markdown for structured sections (headings, numbered lists, bullet points under "Requirements" or "Features" sections)
2. Assign stable IDs (`req-1`, `req-2`, ...) based on order of appearance
3. Store the extracted requirements on the project record (`project.requirements` field in SQLite)
4. When `trace.json` is first created (plan approval), these requirements are written into the `requirements` array

This is best-effort extraction. If the spec doesn't follow a parseable structure, the requirements array may be empty or coarse-grained. The planning agent can also explicitly provide requirement IDs when calling `dispatch_tasks`, overriding the auto-extracted mapping.

### Task-to-Requirement Mapping

The `dispatch_tasks` tool call includes a `tasks` array. Each task has a `description` that references spec sections. The backend can:

1. Accept an optional `requirementIds` field on each task in the `dispatch_tasks` call
2. Fall back to text matching between task descriptions and requirement summaries
3. Allow empty mapping (no requirement link) for infrastructure/setup tasks

---

## 5. Relationship to Other Audit Mechanisms

This design replaces repository-committed agent logs but complements other audit mechanisms:

| Mechanism | Purpose | Retained? |
|-----------|---------|-----------|
| `.harness/trace.json` (new) | End-to-end requirement-to-code traceability, committed to repo | **New** — replaces all below |
| `.harness/logs/` agent dumps (current) | Raw session transcripts in repo | **Removed** — replaced by trace.json |
| `agent_events` SQLite table | Detailed tool calls/results per session | **Retained** — backend's detailed store, source data for trace.json tool call summaries |
| `messages` SQLite table | Chat history (planning agent ↔ user) | **Retained** — conversation record |
| `audit_log` SQLite table (from enterprise-auth) | User action audit trail (API mutations) | **Retained** — complements trace.json (user actions vs agent actions) |
| Execution tab UI | Real-time + historical agent activity view | **Retained** — reads from `agent_events` |

### Distinction from `audit_log`

The `audit_log` table (defined in `enterprise-auth.md`) tracks **user actions**: who created a project, who approved a plan, who triggered a retry. The `trace.json` file tracks **agent actions**: what the agent did, which files it changed, which commits it produced. Together they provide full traceability:

```
User action (audit_log) → Project/Task creation
  → Agent work (trace.json) → Code changes
    → PR review → User approval (audit_log)
```

---

## 6. Enterprise Considerations

### Durability

In local mode (SQLite), `agent_events` data is ephemeral — lost if the database is deleted. The `trace.json` file in the repository is durable and travels with the code. This is the primary reason for repository-anchored traceability.

In enterprise mode (PostgreSQL — see `enterprise-migration.md` Phase 2), the backend database is durable. `trace.json` still provides value as a portable, self-contained audit record that doesn't require access to the harness instance.

### Multi-User Visibility

The `trace.json` format is human-readable JSON. Any team member can:

- View it in a PR review to understand what agents did
- Parse it programmatically for compliance reporting
- Compare it across projects for patterns

The `project.createdBy` field (from OIDC integration) attributes the project to a specific user. Combined with `audit_log`, the full chain of human and agent accountability is captured.

### Compliance

For regulated environments, `trace.json` provides:

- **What was requested**: `requirements` array (from spec)
- **What was planned**: `tasks` array with `planSection` references
- **What was done**: `toolCalls` per attempt
- **What changed**: `commits` and `filesChanged`
- **Who approved**: `specApprovedBy`/`planApprovedBy` fields in `project` (email of the PR approver), with timestamps. Cross-reference with `audit_log` for full user action history.
- **Success/failure**: `exitCode` and `status` per attempt, with retry history

---

## 7. Migration Path

### Phase 0 (with Foundation Hardening)

1. Add `.harness/` guard hook to both agent runners
2. Remove current `.harness/logs/` commit logic from sub-agent, planningTool, and planningAgentManager
3. Add `TraceBuilder` module to backend — constructs and updates `trace.json`
4. Wire `TraceBuilder` into `taskDispatcher.ts` lifecycle events
5. Add requirements extraction to `write_planning_document` handler in `planningTool.ts`

### Testing

- Unit tests for `TraceBuilder`: construction, incremental updates, schema validation
- Unit tests for guard hooks: verify `.harness/` paths blocked for both Bash and file tools
- Integration test: run a project end-to-end, verify `trace.json` is committed with correct structure
- Verify agents cannot read or write `.harness/` paths
