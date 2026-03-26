# Agent Configuration for E2E Tests

## GitHub Copilot

GitHub Copilot is the default provider — unlimited quota, subscription-based.

Configuration:
- Run `./scripts/copy-copilot-auth.sh` once to seed the `harness-pi-auth` Docker volume
- Models are set via `AGENT_PLANNING_MODEL` / `AGENT_IMPLEMENTATION_MODEL` in `.env`
- Default: `github-copilot/gpt-5-mini`

## GitHub Secrets Required

Add these secrets to your GitHub repository:

- `GITHUB_TOKEN` - GitHub personal access token for repository access
- `COPILOT_AUTH_JSON` - Contents of the `harness-pi-auth` volume auth.json (from `copy-copilot-auth.sh`)

## Test Repository

The E2E tests use this dedicated test repository:
`git@github.com:dreef3/multi-agent-harness-test-repo.git`
