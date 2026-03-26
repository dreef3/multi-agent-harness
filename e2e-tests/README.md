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

## Dashboard Completed Projects E2E Test

This optional Playwright e2e test was removed. The dashboard completed-projects behavior is covered by frontend unit tests, which are sufficient and faster to run.

If you previously relied on the e2e test, you can still manually verify the behavior by seeding projects via the API:

  POST /api/repositories
  POST /api/projects
  PATCH /api/projects/:id (set status to "completed")

Or by running the full e2e suite if desired.