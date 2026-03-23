# Git Sync Before Work — Design

**Date:** 2026-03-23
**Status:** Approved

---

## Problem

Sub-agents clone the repository and checkout their feature branch at container start. The branch was created from `defaultBranch` HEAD at task-dispatch time. If other PRs have merged to `defaultBranch` since dispatch — common in fix-run scenarios where the branch may be hours or days old — the sub-agent works on stale code, producing diffs that conflict with reality.

---

## Goals

1. Rebase the feature branch onto the latest `defaultBranch` before any AI work begins
2. On rebase conflict: escalate to the planning agent and wait for a decision rather than silently failing
3. Zero cost on the happy path (fresh branches rebase as a no-op)

## Non-Goals

- AI-driven conflict resolution (the AI does not attempt to fix conflicts)
- Rebasing inside the AI session (the startup script handles it, not the agent)
- Tracking rebase history or surfacing it in the UI beyond existing event forwarding

---

## Files Changed

| File | Change |
|---|---|
| `backend/src/orchestrator/containerManager.ts` | Add `baseBranch?: string` to `ContainerCreateOptions`; inject `BASE_BRANCH` env var |
| `backend/src/orchestrator/taskDispatcher.ts` | Pass `baseBranch: repository.defaultBranch` in `runTask` and `runFixRun` |
| `sub-agent/runner.mjs` | Add rebase block (see below); add `BASE_BRANCH` env read; update `push_branch` tool to use `--force-with-lease` |
| `backend/src/__tests__/containerManager.test.ts` | Tests for `BASE_BRANCH` injection |

---

## Architecture

### Environment injection

`ContainerCreateOptions` gains `baseBranch?: string` (defaults to `"main"` at the backend level). `createSubAgentContainer` injects `BASE_BRANCH=${opts.baseBranch ?? "main"}` into the container env. `TaskDispatcher` passes `repository.defaultBranch` as `baseBranch` in both `runTask` and `runFixRun`.

### Startup script (`sub-agent/runner.mjs`)

`GIT_PUSH_URL` is captured as a module-level constant (`const GIT_PUSH_URL = process.env.GIT_PUSH_URL || REPO_CLONE_URL`) at startup. The rebase block uses this constant for `git fetch`, so it is available throughout the script. However, the rebase block **must execute before `delete process.env.GIT_PUSH_URL`** (the line that clears credentials from the process environment before the AI session starts).

Current order in `runner.mjs`:
1. `git clone GIT_PUSH_URL /workspace/repo`
2. `git checkout BRANCH_NAME`
3. `git remote set-url origin REPO_CLONE_URL`  ← strips auth from remote
4. `delete process.env.GIT_PUSH_URL` / `delete process.env.GITHUB_TOKEN`  ← clears env
5. AI session starts

The rebase block inserts between steps 2 and 3:

```
git checkout BRANCH_NAME
↓
[rebase block — insert here, before remote set-url]
  git fetch GIT_PUSH_URL BASE_BRANCH     (uses captured JS constant — always available)
  git rebase FETCH_HEAD
  → success: continue
  → conflict: git rebase --abort
              POST /api/agents/:id/message  (conflict details)
              await reply
              → reply contains "skip": continue with unrebased branch
              → reply is "abort" or timeout: process.exit(1)
  → fetch error: process.exit(1)
↓
git remote set-url origin REPO_CLONE_URL
delete process.env.GIT_PUSH_URL, GITHUB_TOKEN
↓
AI session starts
```

### Conflict escalation

On rebase conflict the startup script calls `POST /api/agents/${AGENT_SESSION_ID}/message` directly (same long-poll endpoint used by `ask_planning_agent` tool). The request body **must use the `question` field** to match the existing endpoint contract:

```json
{
  "question": "[msgId: <uuid>] [Sub-agent: <AGENT_SESSION_ID>] asks: Rebase conflict on files: <list>. Reply 'skip' to proceed with unrebased branch or 'abort' to cancel this task."
}
```

The planning agent receives this as a system turn and replies via `reply_to_subagent`. The startup script reads the reply:

- Reply containing `"skip"` → continue with current branch state (abort the rebase cleanly first with `git rebase --abort`)
- Anything else (including `"abort"`) → `process.exit(1)`
- Timeout (5 min, matching existing long-poll timeout) → `process.exit(1)`

### Force-push after rebase

After a successful rebase the branch history is rewritten, making a plain `git push` fail with a non-fast-forward error. The `push_branch` tool in `runner.mjs` currently uses a plain push (`git push GIT_PUSH_URL HEAD:BRANCH_NAME`). **This must be updated to `git push --force-with-lease`** to handle the rewritten history correctly without overwriting concurrent pushes.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Fetch fails (network) | `process.exit(1)` — do not proceed on unknown base |
| Rebase no-op (fresh branch already at HEAD) | Continue — zero cost |
| Rebase conflict — planning agent replies "skip" | `git rebase --abort`, continue with unrebased branch |
| Rebase conflict — planning agent replies "abort" | `process.exit(1)` |
| Rebase conflict — planning agent times out (5 min) | `process.exit(1)` |
| `GIT_PUSH_URL` not set | Fall back to `REPO_CLONE_URL` (unauthenticated) — fetch may fail; treated as fetch failure |
| `BASE_BRANCH` env var absent at runtime | Skip rebase block entirely, log warning, continue — treats missing env as "no sync required" |

---

## Testing

- Unit: `containerManager.test.ts` — assert `BASE_BRANCH` is injected with and without the option
- Unit: `taskDispatcher.test.ts` — assert `baseBranch: repository.defaultBranch` passed in `runTask` and `runFixRun`
- Shell integration: `sub-agent/test-git-sync.sh` — real git repo, advance base, verify rebase merges it into feature branch
