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

Credential setup must happen **before the git clone** in both runners, so the clone can use the credential store instead of an embedded token in the URL.

**Sub-agent (`sub-agent/runner.mjs`):**
1. Parse the token out of `GIT_PUSH_URL` using `new URL(GIT_PUSH_URL).password` (format: `https://x-access-token:TOKEN@github.com/org/repo`)
2. Run `git config --global credential.helper store` and write `https://x-access-token:TOKEN@github.com` to `~/.git-credentials` — failure here is fatal (throws)
3. Run `gh auth login --with-token` to store credentials in `~/.config/gh/hosts.yml`
4. Delete `process.env.GIT_PUSH_URL` and `process.env.GITHUB_TOKEN`
5. Clone using `REPO_CLONE_URL` (non-auth) — the credential store supplies the token transparently
6. **After the agent session finishes**, the runner still needs to push the final commit and session log. The code has two `execFileSync("git", ["push", GIT_PUSH_URL, ...])` calls (one for the task commit, one for the session log). Both change to `execFileSync("git", ["push", "origin", ...])` — the credential store handles auth, no stored URL needed

**Planning agent (`planning-agent/runner.mjs`):**
1. Run `git config --global credential.helper store` and write `https://x-access-token:GITHUB_TOKEN@github.com` to `~/.git-credentials` — failure is fatal
2. Run `gh auth login --with-token` using `GITHUB_TOKEN`
3. Delete `process.env.GITHUB_TOKEN` **and** null out the local `GITHUB_TOKEN` variable (the current code captures it at module load with `const GITHUB_TOKEN = process.env.GITHUB_TOKEN`; this variable must not persist after setup)
4. Clone each repo using the non-auth URL (the existing code that builds `https://x-access-token:TOKEN@github.com/...` is removed; the credential store handles auth)

After this point: `git push origin`, `gh pr view`, `gh issue list`, etc. all work. The agent cannot read the token from environment.

### Section 2: BashSpawnHook Command Blocking

Both runners pass a custom bash tool to `createAgentSession` via the `tools` parameter, created with `createCodingTools(cwd, { bash: { spawnHook: guardHook } })`. This replaces only the bash tool's behaviour while keeping the same tool set (`read`, `bash`, `edit`, `write`).

The `spawnHook` receives a `BashSpawnContext` with a `command: string` field containing the raw shell command string. The hook tokenises the command by splitting on whitespace and checks the leading tokens — this avoids false positives from commands like `echo "do not git push --force"`.

Blocked commands are replaced with `printf 'Blocked: ...\n' >&2; exit 1`.

**Blocked in both agents:**

| Leading tokens | Reason |
|---|---|
| `git push --force` / `git push -f` / `git push --force-with-lease` | Prevents overwriting remote history |
| `git push --delete` / `git push -d` | Prevents branch deletion via push |
| `git push https://` (any URL with embedded token) | Prevents auth bypass via inline URL |
| `git branch -D` / `git branch --delete` / `git branch -d` | Prevents branch deletion — `-d` (safe delete) is also blocked since any unintended deletion is worth preventing |
| `gh repo delete` | Prevents repository deletion |
| `gh repo edit` | Prevents visibility/settings changes |
| `gh api` | Prevents raw API calls that could delete branches, refs, or repositories |
| (allowed) `gh pr edit` | Editing PR title/body/labels is safe; not blocked |
| `curl` / `wget` / `httpie` / `http` | Use the `web_fetch` tool instead |

**Blocked only in the planning agent:**

| Leading tokens | Reason |
|---|---|
| `gh pr create` | Must use `write_planning_document` tool so the harness database is updated |

**Implementation notes:**
- Matching checks that the command (stripped of leading whitespace) starts with the blocked token sequence, or that the exact binary name matches (for `curl`, `wget`, etc.)
- Blocked commands return a clear message on stderr telling the agent what to use instead
- The hook never throws — on any internal error it logs and allows the command through

### Section 3: `web_fetch` Custom Tool

A new custom tool added to both agents via `customTools`:

```
name:        web_fetch
description: Fetch the content of a URL. Use this instead of curl or wget.
parameters:  { url: string, method?: "GET"|"POST"|"PUT", body?: string, headers?: object }
```

**Implementation:** Node.js native `fetch` (Node 18+). Returns response body as text.

**Safety constraints:**
- Blocks private IP ranges: `127.x`, `10.x`, `172.16–31.x`, `192.168.x`
- Blocks `localhost` and well-known cloud metadata endpoints (`169.254.169.254` for AWS/GCP/Azure; coverage is GitHub-hosted-runner focused and does not claim to cover all possible cloud environments)
- 30-second hard timeout
- Response body capped at ~200 KB before truncation
- Non-2xx responses returned as an error message with status code and body

**Note:** These constraints apply only to agent-initiated fetches via this tool. Custom tool `execute()` functions (e.g. `ask_planning_agent`, `dispatch_tasks`) call Node.js `fetch()` directly in JavaScript and are unaffected.

### Section 4: Custom Tool Changes

**Sub-agent:**
- Remove `push_branch` tool — `git push origin HEAD:<branch>` works directly via credential store
- Remove the `git remote set-url origin` call and its associated comment that documented the old security model
- Change the three post-session `execFileSync("git", ["push", GIT_PUSH_URL, ...])` calls to `execFileSync("git", ["push", "origin", ...])`
- Keep `ask_planning_agent` unchanged
- Add `web_fetch` to `customTools`

**Planning agent:**
- Keep all existing custom tools unchanged: `write_planning_document`, `dispatch_tasks`, `get_task_status`, `get_pull_requests`, `reply_to_subagent`
- Update `write_planning_document` description: remove "You MUST call this instead of using bash/git/curl to create PRs" and replace with "Use this tool to write planning documents and open the planning PR. To create other PRs, use `gh pr create` directly."
- Add `web_fetch` to `customTools`

**Both agents:**
- Replace `codingTools` default with `createCodingTools(cwd, { bash: { spawnHook: guardHook } })` passed as `tools`
- `web_fetch` and other custom tools continue to go in `customTools`

## Data Flow

### Sub-agent startup sequence
```
1. git config --global credential.helper store
2. write https://x-access-token:TOKEN@github.com to ~/.git-credentials  [fatal on failure]
3. gh auth login --with-token  [warning on failure, non-fatal]
4. delete process.env.GIT_PUSH_URL, process.env.GITHUB_TOKEN
5. git clone <REPO_CLONE_URL> /workspace/repo   ← credential store supplies auth
6. git checkout <BRANCH_NAME>
7. createAgentSession(tools: createCodingTools(...), customTools: [web_fetch, ask_planning_agent])
8. agent runs task
9. git add / git commit
10. git push origin HEAD:<BRANCH_NAME>           ← credential store supplies auth
11. git add session log / git commit
12. git push origin HEAD:<BRANCH_NAME>
```

### Planning agent startup sequence
```
1. git config --global credential.helper store
2. write https://x-access-token:TOKEN@github.com to ~/.git-credentials  [fatal on failure]
3. gh auth login --with-token  [warning on failure, non-fatal]
4. delete process.env.GITHUB_TOKEN
5. for each repo: git clone <non-auth URL>        ← credential store supplies auth
6. createAgentSession(tools: createCodingTools(...), customTools: [web_fetch, write_planning_document, ...])
```

## Files Changed

| File | Change |
|---|---|
| `sub-agent/runner.mjs` | Credential pre-config before clone, simplify clone to non-auth URL, remove `push_branch` + `git remote set-url` hack, change post-session pushes to `git push origin`, add `web_fetch` tool, inject spawnHook via `createCodingTools` |
| `planning-agent/runner.mjs` | Credential pre-config before clone loop, simplify clone to non-auth URL, add `web_fetch` tool, inject spawnHook via `createCodingTools`, update `write_planning_document` description |

No Dockerfile changes required.

## Error Handling

- `~/.git-credentials` write failure: fatal — throw immediately. Without credentials, the clone and all subsequent git operations will fail; there is no useful degraded mode.
- `gh auth login` failure (e.g. `gh` not installed): log a warning and continue — `gh` CLI won't work but git operations are unaffected
- Clone failure after switching to non-auth URL: same as today — surface the error immediately and exit
- Blocked command hook: always returns exit code 1 with a message on stderr; never throws. On internal hook error, allows the command through and logs

## Testing

- Existing E2E tests cover the agent running a task and pushing — these verify credential flow end-to-end
- Unit test for the spawnHook: table-driven tests checking each blocked pattern rejects and each allowed pattern passes through; includes edge cases like embedded-token push URL and echo of a blocked string
- Unit test for `web_fetch`: checks SSRF block on private IPs, timeout, truncation, and non-2xx error handling
