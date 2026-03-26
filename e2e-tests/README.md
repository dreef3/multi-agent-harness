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

This repository includes an optional Playwright e2e test that verifies the Dashboard hides completed
projects by default and shows them when the "Show completed projects" toggle is clicked.

Test file: `tests/dashboard-completed.spec.ts`

How it works:
- The test creates a temporary repository via the harness API, then creates two projects: one completed and one active.
- It then visits the Dashboard page and asserts the completed project is hidden by default.
- It toggles "Show completed projects" and asserts the completed project and its "Completed" badge are visible.

Running the test locally:

1. Ensure the backend API is running (default: http://localhost:3000). You can set HARNESS_API_URL or HARNESS_URL env vars if different.
2. From the `e2e-tests` directory install deps and run the single test:

```bash
cd e2e-tests
npm ci
npx playwright test tests/dashboard-completed.spec.ts
```

Notes:
- The e2e-tests package.json uses `bunx` in scripts; `npm`/`npx` approach above will work if Playwright is installed locally.
- If your environment does not have a running backend, the test will fail. You can seed projects manually via the API:

  POST /api/repositories
  POST /api/projects
  PATCH /api/projects/:id (set status to "completed")

- If running in CI, mark the test as optional or adjust timeouts as appropriate.
