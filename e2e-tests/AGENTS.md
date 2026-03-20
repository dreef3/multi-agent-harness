# Agent Configuration for E2E Tests

This directory contains configuration for running E2E tests with OpenCode Go agent provider.

## OpenCode Go

OpenCode Go is the Go implementation of the OpenCode agent framework.

Configuration:
- Set `AGENT_PROVIDER=opencode-go` in environment (default)
- Set `OPENCODE_API_KEY` to your API key (required)

## GitHub Secrets Required

Add these secrets to your GitHub repository:

- `GITHUB_TOKEN` - GitHub personal access token for repository access
- `OPENCODE_API_KEY` - API key for OpenCode Go agent

## Optional Secrets

- `ANTHROPIC_API_KEY` - Only needed if you want to use Claude models as fallback

## Test Repository

The E2E tests use this dedicated test repository:
`git@github.com:dreef3/multi-agent-harness-test-repo.git`

This repository contains a simple codebase for testing agent capabilities.
