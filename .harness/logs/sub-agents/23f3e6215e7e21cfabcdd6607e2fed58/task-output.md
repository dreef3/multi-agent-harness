# Task Output

Task: You are a software engineering sub-agent. Follow this workflow exactly.

## Step 1 — Understand the Task
Read the task description below carefully. If a plan file exists in the repository
at docs/superpowers/plans/, read it to understand the full project context before
starting.

## Step 2 — Test-Driven Development
Follow strict TDD. For every behaviour you implement:
1. Write a failing test first. Run it and confirm it fails for the right reason.
2. Write the minimum code to make it pass. Run it and confirm it passes.
3. Refactor. Keep tests green.
Never write production code without a failing test first.

## Step 3 — Implement
Work through the task description step by step. Commit logical units of work with
clear messages. Do not make changes beyond the scope of the task.

## Step 4 — Systematic Debugging
If you encounter a bug or unexpected behaviour:
1. Reproduce it reliably first.
2. Form a hypothesis about the root cause.
3. Test the hypothesis before attempting a fix.
4. Fix only after confirming the root cause.
Never guess-and-check. Root cause first, always.

## Step 5 — Verify Before Finishing
Before considering the task done:
1. Run the full test suite. Show the command and its output.
2. Confirm every acceptance criterion in the task description is met.
3. Do not claim completion without fresh evidence.
If verification fails, go back and fix — do not push broken code.

## Step 6 — Commit and Push
Stage and commit all changes. The harness will open the pull request automatically.

---

## Your Task

Task: Update Dashboard unit tests to use completed-projects expander

Goal: Update frontend/src/pages/Dashboard.test.tsx to remove references to the header checkbox and instead test the new expander control (Show N completed projects). This is a test-first step: update tests, run them to observe failures, commit the change.

Steps (self-contained):
1. Create and checkout a new branch for the work:
   git checkout -b feat/dashboard-completed-expander

2. Replace the file frontend/src/pages/Dashboard.test.tsx with the following complete content:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import type { Project } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    projects: {
      list: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue({ dispatched: 1, agentRestarted: true }),
    },
  },
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    status: 'executing',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Dashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Retry button for failed projects', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([makeProject({ status: 'failed' })]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Retry$/i })).toBeInTheDocument());
  });

  it('shows Retry button for error projects', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([makeProject({ status: 'error' })]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Retry$/i })).toBeInTheDocument());
  });

  it('does not show Retry button for executing projects', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([makeProject({ status: 'executing' })]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Test Project')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Retry$/i })).not.toBeInTheDocument();
  });

  it('displays lastError message under the project name', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([
      makeProject({ status: 'failed', lastError: 'no space left on device' }),
    ]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('no space left on device')).toBeInTheDocument());
  });

  it('calls retry API and reloads projects when Retry is clicked', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list)
      .mockResolvedValueOnce([makeProject({ status: 'failed' })])
      .mockResolvedValueOnce([makeProject({ status: 'executing' })]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const retryBtn = await screen.findByRole('button', { name: /^Retry$/i });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(api.projects.retry).toHaveBeenCalledWith('proj-1'));
  });

  it("does not show completed projects by default", async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([
      makeProject({ id: 'c1', name: 'Completed Project', status: 'completed' }),
      makeProject({ id: 'p2', name: 'Other Project', status: 'executing' }),
    ]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Other Project')).toBeInTheDocument());
    expect(screen.queryByText('Completed Project')).not.toBeInTheDocument();
  });

  it('shows completed project when expander is clicked', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([
      makeProject({ id: 'c1', name: 'Completed Project', status: 'completed' }),
    ]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const expander = await screen.findByRole('button', { name: /Show .* completed projects/i });
    fireEvent.click(expander);
    await waitFor(() => expect(screen.getByText('Completed Project')).toBeInTheDocument());
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('does not render Execute button for completed projects when visible', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.projects.list).mockResolvedValue([
      makeProject({ id: 'c1', name: 'Completed Project', status: 'completed' }),
    ]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const expander = await screen.findByRole('button', { name: /Show .* completed projects/i });
    fireEvent.click(expander);
    await waitFor(() => expect(screen.getByText('Completed Project')).toBeInTheDocument());
    expect(screen.queryByText('Execute')).not.toBeInTheDocument();
    // Completed projects should not have Retry actions available
    expect(screen.queryByRole('button', { name: /^Retry$/i })).not.toBeInTheDocument();
  });
});
```

3. Run the single test file to observe the test results:
   cd frontend
   npm run test -- src/pages/Dashboard.test.tsx

4. If tests fail (expected until implementation is added), continue. Commit the test file change:
   git add frontend/src/pages/Dashboard.test.tsx
   git commit -m "test: update Dashboard tests to use completed-projects expander"

5. Push branch and leave it for the implementation task (push to origin):
   git push --set-upstream origin feat/dashboard-completed-expander

Notes:
- Use existing project linting and test environment. If Vitest setup requires specific env variables, configure them as in the repository.
- If any test harness adjustments are required, document them in the commit message.


Note: AI agent completed but made no file changes.
Completed at: 2026-03-27T22:08:07.104Z
