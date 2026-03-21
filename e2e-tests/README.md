# E2E Tests

## Repository Flow Test

The repository flow test requires:

- A GitHub repository with write access
- `GITHUB_TOKEN` environment variable with `repo` scope
- `TEST_REPO_OWNER` and `TEST_REPO_NAME` environment variables (defaults to dreef3/multi-agent-harness-test-repo)

### Running

```bash
GITHUB_TOKEN=your_token bun run test:repo
```

### Test Repository

The test repository must be pre-initialized with sample code (e.g., Spring Pet Clinic or similar).