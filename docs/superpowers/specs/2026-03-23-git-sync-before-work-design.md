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

## Architecture

### Environment injection

`ContainerCreateOptions` gains `baseBranch?: string` (defaults to `"main"`). `createSubAgentContainer` injects `BASE_BRANCH=${opts.baseBranch ?? "main"}` into the container env. `TaskDispatcher` passes `repository.defaultBranch` as `baseBranch` in both `runTask` and `runFixRun`.

### Startup script (`sub-agent/runner.mjs`)

The rebase block executes after `git checkout BRANCH_NAME` and **before** `git remote set-url origin REPO_CLONE_URL` (the credential strip). This ordering is critical: `git fetch` uses `GIT_PUSH_URL` (authenticated), which is available only before the strip.

```
git checkout BRANCH_NAME
↓
[rebase block]
  git fetch GIT_PUSH_URL BASE_BRANCH
  git rebase FETCH_HEAD
  → success: continue
  → conflict: git rebase --abort
              POST /api/agents/:id/message  (conflict details)
              await reply
              → "skip": continue with unrebased branch
              → "abort": process.exit(1)
  → fetch error: process.exit(1)
↓
git remote set-url origin REPO_CLONE_URL   (strip auth)
delete GIT_PUSH_URL, GITHUB_TOKEN
↓
AI session starts
```

### Conflict escalation

On rebase conflict the startup script calls `POST /api/agents/${AGENT_SESSION_ID}/message` directly (same long-poll endpoint used by `ask_planning_agent` tool). The request body:

```json
{
  "text": "[msgId: <uuid>] [Sub-agent: <AGENT_SESSION_ID>] asks: Rebase conflict on files: <list>. Reply 'skip' to proceed with unrebased branch or 'abort' to cancel this task."
}
```

The planning agent receives this as a system turn and replies via `reply_to_subagent`. The startup script reads the reply:

- `"skip"` (or any reply containing "skip") → continue with current branch state
- Anything else (including `"abort"`) → `process.exit(1)`
- Timeout (5 min, matching existing long-poll timeout) → `process.exit(1)`

### Force-push after rebase

After a successful rebase the branch history is rewritten. The existing `push_branch` tool already uses `git push --force-with-lease`, which handles this correctly without overwriting concurrent pushes.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Fetch fails (network) | `process.exit(1)` — do not proceed on unknown base |
| Rebase no-op (fresh branch already at HEAD) | Continue — zero cost |
| Rebase conflict — planning agent replies "skip" | Continue with unrebased branch |
| Rebase conflict — planning agent replies "abort" | `process.exit(1)` |
| Rebase conflict — planning agent times out (5 min) | `process.exit(1)` |
| `GIT_PUSH_URL` not set | Fall back to `REPO_CLONE_URL` (unauthenticated) — fetch may fail; treated as fetch failure |

---

## Testing

- Unit: `containerManager.test.ts` — assert `BASE_BRANCH` is injected with and without the option
- Unit: `taskDispatcher.test.ts` — assert `baseBranch: repository.defaultBranch` passed in `runTask` and `runFixRun`
- Shell integration: `sub-agent/test-git-sync.sh` — real git repo, advance base, verify rebase merges it into feature branch
