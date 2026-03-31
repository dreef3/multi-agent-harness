# Repository Configuration for Projects — Design Spec

## Goal

Enable users to configure repositories (GitHub/Bitbucket Server) in the Settings page and select one or more repositories when creating a new project. Add an E2E test that creates a project, goes through the full brainstorm/plan/approve flow, dispatches a sub-agent, and verifies a PR is created in a test repository.

## Scope

- **Settings Page:** Add repository management UI (CRUD for repositories)
- **NewProject Page:** Add repository multi-select 
- **E2E Test:** Full happy path flow from project creation to PR creation
- **Single-user system:** Credentials pre-configured via environment variables

## Out of Scope

- Multi-user authentication
- Per-repository credential overrides
- JIRA repository integration
- Automatic repository discovery

---

## Architecture

The existing `Repository` model already supports:
- `provider`: "github" | "bitbucket-server"
- `providerConfig`: owner/repo for GitHub, projectKey/repoSlug/baseUrl for Bitbucket
- `cloneUrl`, `defaultBranch`

No backend model changes required. Credentials remain environment-based (`GITHUB_TOKEN`, `BITBUCKET_TOKEN`).

---

## Backend Changes

### New Endpoint: Provider Status

**File:** `backend/src/api/settings.ts`

**Endpoint:** `GET /api/settings/providers`

Returns available providers and whether credentials are configured:

```typescript
interface ProviderStatus {
  name: "github" | "bitbucket-server";
  configured: boolean;
}

// Response:
{
  providers: [
    { name: "github", configured: true },
    { name: "bitbucket-server", configured: false }
  ]
}
```

Implementation checks environment variables:
- GitHub: `process.env.GITHUB_TOKEN` is set
- Bitbucket: `process.env.BITBUCKET_TOKEN` and `process.env.BITBUCKET_BASE_URL` are set

### Existing Endpoints (No Changes)

- `GET /api/repositories` - List all configured repositories
- `POST /api/repositories` - Create new repository
- `GET /api/repositories/:id` - Get repository by ID
- `PATCH /api/repositories/:id` - Update repository
- `DELETE /api/repositories/:id` - Delete repository

---

## Frontend Changes

### Settings Page: Repositories Section

**File:** `frontend/src/pages/Settings.tsx`

Add a "Repositories" section after the existing model configuration:

**UI Elements:**
- Title: "Configured Repositories"
- List of existing repositories (name, provider badge, clone URL)
- "Add Repository" button opens a modal/form
- Per-repository Edit/Delete actions

**Repository Form:**
- **Name:** Display name (required)
- **Provider:** Dropdown (GitHub / Bitbucket Server)
- **GitHub fields:** Owner, Repository name, Default branch (defaults to "main")
- **Bitbucket fields:** Base URL, Project Key, Repository Slug, Default branch

**Note displayed:** "Credentials are configured via environment variables (GITHUB_TOKEN for GitHub, BITBUCKET_TOKEN for Bitbucket Server)."

### NewProject Page: Repository Selection

**File:** `frontend/src/pages/NewProject.tsx`

Add repository selection after the description textarea:

**UI Elements:**
- Title: "Repositories"
- Multi-select dropdown showing configured repositories
- Selected repositories displayed as removable tags/badges
- At least one repository required to create project

**Data Flow:**
- Fetch repositories on mount: `GET /api/repositories`
- Include `repositoryIds` in project creation payload
- React to project creation success by navigating to chat page

### API Client Types

**File:** `frontend/src/lib/api.ts`

Add Repository interface:

```typescript
export interface Repository {
  id: string;
  name: string;
  cloneUrl: string;
  provider: "github" | "bitbucket-server";
  providerConfig: {
    owner?: string;
    repo?: string;
    projectKey?: string;
    repoSlug?: string;
    baseUrl?: string;
  };
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## E2E Test

### Test File

**File:** `e2e-tests/tests/repository-flow.spec.ts`

### Prerequisites

1. Test repository pre-initialized with sample code: `https://github.com/dreef3/multi-agent-harness-test-repo`
2. `GITHUB_TOKEN` environment variable set with PAT having write access to testrepo
3. Backend and frontend running (via `npm run dev` or Docker Compose)

### Test Flow

```typescript
test('create project with repository and generate PR', async ({ page, request }) => {
  // 1. Seed repository via API
  const repo = await createTestRepository(request);
  
  // 2. Navigate to new project
  await page.goto('/');
  await page.getByRole('link', { name: /\+ new project/i }).click();
  
  // 3. Fill in project details
  await page.getByPlaceholder(/my awesome project/i).fill('E2E Repo Test');
  await page.getByPlaceholder(/what do you want to build/i)
    .fill('Add a README file with project description');
  
  // 4. Select repository
  await page.getByRole('button', { name: /select repository/i }).click();
  await page.getByText(repo.name).click();
  
  // 5. Create project
  await page.getByRole('button', { name: /create project/i }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+\/chat/);
  
  // 6. Trigger brainstorming
  await page.getByPlaceholder(/type your message/i)
    .fill('Create a README file for this project');
  await page.getByRole('button', { name: /send/i }).click();
  
  // 7. Wait for plan generation
  await expect(page.getByText(/plan/i)).toBeVisible({ timeout: 120000 });
  
  // 8. Navigate to plan approval
  await page.goto(page.url().replace('/chat', '/plan'));
  
  // 9. Approve plan
  await page.getByRole('button', { name: /approve/i }).click();
  
  // 10. Wait for execution to start
  await expect(page.getByText(/executing/i)).toBeVisible({ timeout: 30000 });
  
  // 11. Poll for PR creation
  const projectId = extractProjectId(page.url());
  const pr = await waitForPR(request, projectId);
  
  // 12. Verify PR exists
  expect(pr.status).toBe('open');
  expect(pr.url).toContain('github.com');
});
```

### Helper Functions

```typescript
async function createTestRepository(request: APIRequestContext) {
  const response = await request.post('http://localhost:3000/api/repositories', {
    body: JSON.stringify({
      name: 'Test Repo',
      provider: 'github',
      providerConfig: {
        owner: 'dreef3',
        repo: 'multi-agent-harness-test-repo'
      },
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/dreef3/multi-agent-harness-test-repo.git'
    })
  });
  return response.json();
}

async function waitForPR(request: APIRequestContext, projectId: string) {
  for (let i = 0; i < 60; i++) {
    const response = await request.get(
      `http://localhost:3000/api/projects/${projectId}/prs`
    );
    const prs = await response.json();
    if (prs.length > 0) return prs[0];
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('PR not created within timeout');
}
```

### Test Configuration

Add to `.env` for E2E tests:
```
GITHUB_TOKEN=<test-token-with-write-access>
TEST_REPO_OWNER=dreef3
TEST_REPO_NAME=multi-agent-harness-test-repo
```

---

## File Map

| File | Change |
|------|--------|
| `backend/src/api/settings.ts` | New file: provider status endpoint |
| `backend/src/api/routes.ts` | Mount settings router |
| `frontend/src/pages/Settings.tsx` | Add Repositories section |
| `frontend/src/pages/NewProject.tsx` | Add repository multi-select |
| `frontend/src/lib/api.ts` | Add Repository interface and API methods |
| `frontend/src/components/RepositoryForm.tsx` | New file: repository form component |
| `e2e-tests/tests/repository-flow.spec.ts` | New file: E2E test |
| `e2e-tests/playwright.config.ts` | Add test timeout for long-running tests |

---

## Security Considerations

- **Credentials:** Never stored in database, only in environment variables
- **Token Scope:** `GITHUB_TOKEN` needs `repo` scope for creating branches/PRs
- **Test Isolation:** E2E test should use a dedicated test repository to avoid conflicts

---

## Testing Strategy

1. **Unit Tests:** Repository form validation, API client methods
2. **Integration Tests:** Backend settings endpoint, repository CRUD
3. **E2E Test:** Full flow from project creation to PR creation

---

## Rollout Plan

1. Implement backend settings endpoint
2. Implement frontend Settings page repository section
3. Implement frontend NewProject repository selection
4. Write and verify E2E test
5. Update `.env.example` with required variables