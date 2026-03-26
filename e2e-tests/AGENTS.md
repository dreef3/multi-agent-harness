# Agent Configuration for E2E Tests

## GitHub Copilot

GitHub Copilot is the default provider — unlimited quota, subscription-based.

Configuration:
- Set `COPILOT_GITHUB_TOKEN` in `.env` to a fine-grained PAT with "Copilot Requests" permission
- Models are set via `AGENT_PLANNING_MODEL` / `AGENT_IMPLEMENTATION_MODEL` in `.env`
- Default: `github-copilot/gpt-5-mini`
- Auth is bootstrapped automatically by the agent runners on startup — no manual volume seeding needed

## GitHub Secrets Required

Add these secrets to your GitHub repository:

- `GH_TOKEN` - Fine-grained PAT with "Copilot Requests" permission (used for both repo access and Copilot auth)

## Test Repository

The E2E tests use this dedicated test repository:
`git@github.com:dreef3/multi-agent-harness-test-repo.git`
