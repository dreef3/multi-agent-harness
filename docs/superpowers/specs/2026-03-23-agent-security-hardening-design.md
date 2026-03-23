# Agent Security Hardening Design

**Date:** 2026-03-23
**Status:** Draft

## Overview

Replace the current approach of stripping auth tokens and substituting custom tools for `git push` and `gh pr create` with a cleaner model: pre-configure credentials so `git` and `gh` CLI work normally, then use `BashSpawnHook` to deny destructive commands and a custom `web_fetch` tool to replace `curl`/`wget`.

Applies to both the sub-agent (`sub-agent/runner.mjs`) and the planning agent (`planning-agent/runner.mjs`).

## Motivation

The current approach has two problems:

1. **Sub-agent**: `GIT_PUSH_URL` is extracted before the agent starts, `origin` is reset to a non-auth URL, and a `push_branch` custom tool is injected so the agent can push at all. This is unnecessarily limiting — the agent cannot use `git push` in any normal workflow.

2. **Planning agent**: `GITHUB_TOKEN` is deleted after cloning, which disables `gh` CLI entirely. The agent is forced to use `write_planning_document` for all VCS interactions, even read-only ones like `gh pr view` or `gh issue list`.

The goal is to allow `git` and `gh` to work normally while blocking specifically destructive and policy-violating operations.

## Architecture

### Section 1: Credential Pre-configuration and Token Hiding

Before `createAgentSession` is called in each runner:

**Sub-agent (`sub-agent/runner.mjs`):**
1. Parse the token out of `GIT_PUSH_URL` (format: `https://x-access-token:TOKEN@github.com/org/repo`)
2. Configure git global credential store: `git config --global credential.helper store` and write an entry to `~/.git-credentials`
3. Run `gh auth login --with-token` to store credentials in `~/.config/gh/hosts.yml`
4. Delete `process.env.GIT_PUSH_URL` and `process.env.GITHUB_TOKEN`
5. Leave `origin` pointing to the non-auth clone URL — git will supply credentials via the credential store transparently

**Planning agent (`planning-agent/runner.mjs`):**
1. Configure git global credential store and write `GITHUB_TOKEN` to `~/.git-credentials`
2. Run `gh auth login --with-token` using `GITHUB_TOKEN`
3. Delete `process.env.GITHUB_TOKEN`

After this point: `git push`, `gh pr view`, `gh issue list`, etc. all work. The agent cannot read the token from environment.

### Section 2: BashSpawnHook Command Blocking

Both runners replace the default `bashTool` with a custom tool built via `createBashTool(cwd, { spawnHook })`. The hook inspects each command string before execution. Blocked commands are replaced with `printf 'Blocked: ...\n' >&2; exit 1`.

**Blocked in both agents:**

| Pattern | Reason |
|---|---|
| `git push --force`, `git push -f`, `git push --force-with-lease` | Prevents overwriting remote history |
| `git push --delete`, `git push -d` | Prevents branch deletion via push |
| `git branch -D`, `git branch --delete`, `git branch -d` | Prevents local/remote branch deletion |
| `gh repo delete` | Prevents repository deletion |
| `gh repo edit` | Prevents visibility/settings changes |
| `gh branch delete`, `gh branch edit` | Prevents branch management via gh |
| `curl`, `wget`, `httpie`, `http` | Use the `web_fetch` tool instead |

**Blocked only in the planning agent:**

| Pattern | Reason |
|---|---|
| `gh pr create` | Must use `write_planning_document` tool to create planning PRs so the harness database is updated |

**Implementation notes:**
- Matching is prefix/substring on the command string — sufficient for accident prevention, not adversarial containment
- Blocked commands return a clear message telling the agent what to use instead
- The custom bash tool is passed via `tools: [customBashTool, readTool, editTool, writeTool, grepTool, findTool, lsTool]` to `createAgentSession`

### Section 3: `web_fetch` Custom Tool

A new custom tool added to both agents:

```
name:        web_fetch
description: Fetch the content of a URL. Use this instead of curl or wget.
parameters:  { url: string, method?: "GET"|"POST"|"PUT", body?: string, headers?: object }
```

**Implementation:** Node.js native `fetch` (Node 18+). Returns response body as text.

**Safety constraints:**
- Blocks private IP ranges: `127.x`, `10.x`, `172.16–31.x`, `192.168.x`
- Blocks `localhost` and Docker metadata endpoint (`169.254.169.254`)
- 30-second hard timeout
- Response body capped at ~200 KB before truncation
- Non-2xx responses returned as an error message with status code and body

**Note:** These constraints apply only to agent-initiated fetches via this tool. Custom tool `execute()` functions (e.g. `ask_planning_agent`, `dispatch_tasks`) call Node.js `fetch()` directly in JavaScript and are unaffected.

### Section 4: Custom Tool Changes

**Sub-agent:**
- Remove `push_branch` tool — `git push` works directly via credential store
- Remove the `git remote set-url origin` call that stripped auth from the remote
- Keep `ask_planning_agent` unchanged
- Add `web_fetch` tool

**Planning agent:**
- Keep all existing custom tools unchanged: `write_planning_document`, `dispatch_tasks`, `get_task_status`, `get_pull_requests`, `reply_to_subagent`
- Update `write_planning_document` description: remove "You MUST call this instead of using bash/git/curl to create PRs" and replace with "Use this tool to write planning documents and open the planning PR. To create other PRs, use `gh pr create` directly."
- Add `web_fetch` tool

## Data Flow

### Sub-agent startup sequence
```
1. git config + write ~/.git-credentials (from GIT_PUSH_URL token)
2. gh auth login --with-token
3. delete process.env.GIT_PUSH_URL, process.env.GITHUB_TOKEN
4. git clone <non-auth URL> /workspace/repo    ← fails if pre-config missed?
```

Wait — cloning happens *before* agent startup in the sub-agent. The current code clones using `GIT_PUSH_URL` before the agent starts. Credential pre-config must happen *before* the clone, so the clone can use the credential store instead of the embedded URL. The clone call changes from `git clone GIT_PUSH_URL ...` to `git clone REPO_CLONE_URL ...` (non-auth), with the credential store supplying auth.

Updated sub-agent sequence:
```
1. git config --global credential.helper store
2. write ~/.git-credentials with token from GIT_PUSH_URL
3. gh auth login --with-token (token extracted from GIT_PUSH_URL)
4. delete process.env.GIT_PUSH_URL, process.env.GITHUB_TOKEN
5. git clone <REPO_CLONE_URL> /workspace/repo  ← credential store used
6. git checkout <BRANCH_NAME>
7. createAgentSession(...)
```

### Planning agent startup sequence
```
1. git config --global credential.helper store
2. write ~/.git-credentials with GITHUB_TOKEN
3. gh auth login --with-token
4. delete process.env.GITHUB_TOKEN
5. git clone (already uses authenticated URL built from GITHUB_TOKEN, but now uses credential store)
6. createAgentSession(...)
```

Wait — the planning agent currently builds the authenticated clone URL *using* `GITHUB_TOKEN` before deleting it. Since we're moving credential setup before the clone, the clone should use the non-auth URL with credential store supplying auth. This simplifies the clone loop in `planning-agent/runner.mjs`.

## Files Changed

| File | Change |
|---|---|
| `sub-agent/runner.mjs` | Credential pre-config, remove `push_branch` + `git remote set-url` hack, add `web_fetch` tool, add spawnHook bash tool |
| `planning-agent/runner.mjs` | Credential pre-config before clone loop, simplify clone (non-auth URL), add `web_fetch` tool, add spawnHook bash tool, update `write_planning_document` description |

No Dockerfile changes required.

## Error Handling

- If credential pre-config fails (e.g. `gh` not installed), log a warning and continue — the agent will still work for most operations, just without gh auth
- If clone fails after switching to non-auth URL + credential store, surface the error immediately (same as today)
- Blocked command hook: always returns exit code 1 with a message on stderr; never throws

## Testing

- Existing E2E tests cover the agent running a task and pushing — these verify credential flow end-to-end
- Unit test for the spawnHook: table-driven, checks each blocked pattern returns the error command and each allowed pattern passes through unchanged
- Unit test for `web_fetch`: checks SSRF block, timeout, truncation, and error status handling
