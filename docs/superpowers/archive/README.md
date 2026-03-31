# Archived Specs & Plans

Design specs and implementation plans from the initial development phase (2026-03-20 to 2026-03-27). All features described here have been implemented and merged.

For the current architecture, see [docs/architecture.md](../../architecture.md).

## Specs (17 documents)

| Date | Spec | Feature |
|------|------|---------|
| 03-20 | multi-agent-harness-design | Foundation architecture |
| 03-21 | repository-configuration-design | Repository CRUD and settings |
| 03-22 | pr-based-planning-flow-design | PR-based spec/plan approval with LGTM gates |
| 03-22 | planning-agent-design | Planning agent in Docker container (TCP RPC) |
| 03-22 | self-healing-subagents-design | Auto-retry, stale recovery, master notification |
| 03-23 | agent-log-persistence-design | SQLite events table, session logs in git |
| 03-23 | repository-ux-design | Repository list UI, status badges |
| 03-23 | agent-security-hardening-design | Guard hooks, web_fetch SSRF protection |
| 03-23 | subagent-communication-execution-tab-design | Bidirectional agent messaging, execution UI |
| 03-23 | chat-flash-fix-design | Message dedup, reconnect stability |
| 03-23 | markdown-tables-design | GFM support in chat (remark-gfm) |
| 03-24 | padding-in-chat-design | Mobile responsive padding |
| 03-24 | harness-bug-fixes-design | 7 bugs: ordering, input perf, lifecycle, recovery |
| 03-25 | agent-workflow-optimization-design | RTK, two-tier concurrency, idempotent dispatch, OTel |
| 03-26 | hide-or-archive-completed-projects-design | Dashboard filtering |
| 03-26 | project-lifecycle-fixes-design | All-PRs-merged completion, reactivation |
| 03-27 | frontend-navigation-bug-design | Back link, history replace |

## Plans (19 documents)

Implementation plans corresponding to the specs above, plus 3 foundation sub-project plans from 03-20.
