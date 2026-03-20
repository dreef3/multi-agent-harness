# Agent Configuration for E2E Tests

This directory contains configuration for running E2E tests with different agent providers.

## Supported Agents

### OpenCode Zen
OpenCode Zen is the TypeScript/JavaScript implementation of the OpenCode agent framework.

Configuration:
- Set `AGENT_PROVIDER=opencode-zen` in environment
- Set `OPENCODE_API_KEY` to your API key

### OpenCode Go
OpenCode Go is the Go implementation of the OpenCode agent framework.

Configuration:
- Set `AGENT_PROVIDER=opencode-go` in environment  
- Set `OPENCODE_API_KEY` to your API key

## GitHub Secrets Required

Add these secrets to your GitHub repository:

- `ANTHROPIC_API_KEY` - API key for Anthropic (Claude models)
- `GITHUB_TOKEN` - GitHub personal access token for repository access
- `OPENCODE_API_KEY` - API key for OpenCode services (if using OpenCode agents)

## Test Repository

The E2E tests use this dedicated test repository:
`git@github.com:dreef3/multi-agent-harness-test-repo.git`

This repository contains a simple codebase for testing agent capabilities.
