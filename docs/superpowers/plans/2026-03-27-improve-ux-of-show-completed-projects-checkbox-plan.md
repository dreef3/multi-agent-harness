# Completed Projects Expander Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the header "Show completed projects" checkbox on the Projects dashboard with a visually-integrated, accessible expander control at the end of the active projects list that reveals completed projects when clicked.

**Architecture:** Inline UI change within Dashboard.tsx. No new components or backend changes. Update unit tests in place to reflect the new UI.

**Tech Stack:** React + TypeScript, Tailwind CSS, Vitest + @testing-library/react for unit tests.

---

Scope check
- Single frontend change localized to Dashboard page and its unit tests.
- Plan assumes tests run with the repository's existing test runner: `cd frontend && npm run test`.

File map (what will be changed)
- Modify: `frontend/src/pages/Dashboard.tsx` — remove header checkbox, add inline expander button and collapsible completed region, compute active/completed lists.
- Modify: `frontend/src/pages/Dashboard.test.tsx` — update tests to target the new expander button and assertions.

High-level task breakdown
- Task 1: Update/extend tests to assert new behavior (make tests fail first)
- Task 2: Implement UI changes in Dashboard.tsx
- Task 3: Run tests, fix issues, and iterate until all tests pass
- Task 4: Final commit(s) with clear messages
- Task 5: Request plan-document-reviewer review (already dispatched separately)

Detailed tasks

### Task 1: Update tests to cover the new expander behavior

**Files:**
- Modify: `frontend/src/pages/Dashboard.test.tsx`

- [ ] Step 1: Edit `frontend/src/pages/Dashboard.test.tsx` to replace checkbox-based interactions with the expander button.

Replace occurrences that reference the header checkbox label `Show completed projects` with the new expander button selection logic. Below is a suggested updated file content (complete):

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

- [ ] Step 2: Run tests to verify the updated tests fail (they should fail until Dashboard is updated).

Run:

```bash
cd frontend
npm run test -- src/pages/Dashboard.test.tsx
```

Expected: At least one failing test related to the new expander expectations (likely because the Dashboard still renders the header checkbox).

- [ ] Step 3: Commit the test changes

```bash
git add frontend/src/pages/Dashboard.test.tsx
git commit -m "test: update Dashboard tests to use completed-projects expander"
```


### Task 2: Implement the expander UI in Dashboard

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] Step 1: Edit `frontend/src/pages/Dashboard.tsx` to remove the header checkbox and add inline expander + collapsible region.

Below is a complete suggested replacement file content for Dashboard.tsx. Use it as the implementation target.

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Project } from "../lib/api";

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      setLoading(true);
      const data = await api.projects.list();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this project?")) return;
    try {
      await api.projects.delete(id);
      setProjects(projects.filter((p) => p.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete project");
    }
  }

  async function handleRetry(id: string) {
    setRetrying((prev) => new Set([...prev, id]));
    try {
      await api.projects.retry(id);
      await loadProjects();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to retry project");
    } finally {
      setRetrying((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
    }
  }

  const statusColors: Record<string, string> = {
    draft: "bg-gray-700",
    brainstorming: "bg-gray-600",
    spec_in_progress: "bg-blue-600",
    awaiting_spec_approval: "bg-amber-600",
    plan_in_progress: "bg-blue-600",
    awaiting_plan_approval: "bg-amber-600",
    executing: "bg-blue-700",
    completed: "bg-purple-600",
    failed: "bg-red-600",
    cancelled: "bg-gray-700",
    error: "bg-red-600",
  };

  const statusLabels: Record<string, string> = {
    draft: "Draft",
    brainstorming: "Brainstorming",
    spec_in_progress: "Writing Spec",
    awaiting_spec_approval: "Awaiting Spec Approval",
    plan_in_progress: "Writing Plan",
    awaiting_plan_approval: "Awaiting Plan Approval",
    executing: "Executing",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    error: "Error",
  };

  if (loading) return <div className="text-gray-400">Loading...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;

  const activeProjects = projects.filter((p) => p.status !== "completed");
  const completedProjects = projects.filter((p) => p.status === "completed");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <div className="flex items-center gap-4">
          <Link
            to="/projects/new"
            className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium"
          >
            + New Project
          </Link>
        </div>
      </div>

      {activeProjects.length === 0 ? (
        <div className="text-gray-500 text-center py-12">
          No projects yet. Create your first project to get started.
        </div>
      ) : (
        <div className="grid gap-4">
          {activeProjects.map((project) => {
            const isCompleted = project.status === "completed";
            const cardClass = `bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between ${isCompleted ? "opacity-70" : ""}`;
            const badgeClass = isCompleted
              ? "text-xs px-2 py-1 rounded-full bg-gray-600 text-gray-200"
              : `text-xs px-2 py-1 rounded-full ${statusColors[project.status] || "bg-gray-700"}`;

            return (
              <article
                key={project.id}
                aria-label={`Project ${project.name} ${isCompleted ? "— Completed" : ""}`}
                className={cardClass}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-lg">{project.name}</h3>
                    <span className={badgeClass}>
                      {statusLabels[project.status] ?? project.status}
                    </span>
                  </div>
                  <p className="text-gray-400 text-sm">{project.description}</p>
                  <p className="text-gray-500 text-xs">
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </p>
                  {project.lastError && (
                    <p className="text-red-400 text-xs mt-1">{project.lastError}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    to={`/projects/${project.id}/chat`}
                    className="text-blue-400 hover:text-blue-300 px-3 py-1 text-sm"
                  >
                    Chat
                  </Link>
                  {(project.status === "awaiting_spec_approval" || project.status === "awaiting_plan_approval") && project.planningPr?.url && (
                    <a
                      href={project.planningPr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 hover:text-amber-300 px-3 py-1 text-sm"
                    >
                      Review PR ↗
                    </a>
                  )}
                  {!isCompleted && (
                    <Link
                      to={`/projects/${project.id}/execute`}
                      className="text-purple-400 hover:text-purple-300 px-3 py-1 text-sm"
                    >
                      Execute
                    </Link>
                  )}
                  {(project.status === "failed" || project.status === "error") && !isCompleted && (
                    <button
                      onClick={() => handleRetry(project.id)}
                      disabled={retrying.has(project.id)}
                      className="text-green-400 hover:text-green-300 disabled:text-gray-600 disabled:cursor-not-allowed px-3 py-1 text-sm"
                    >
                      {retrying.has(project.id) ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(project.id)}
                    className="text-red-400 hover:text-red-300 px-3 py-1 text-sm"
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}

          {/* Expander control and completed region */}
          {completedProjects.length > 0 && (
            <div>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls="completed-projects-region"
                onClick={() => setExpanded((s) => !s)}
                className="w-full flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-300 hover:text-gray-200 transition-colors"
              >
                <span>{expanded ? 'Hide completed projects' : `Show ${completedProjects.length} completed projects`}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`w-5 h-5 text-gray-400 transform transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                >
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 011.08 1.04l-4.25 4.25a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>

              <div
                id="completed-projects-region"
                role="region"
                className={`overflow-hidden transition-all duration-200 ${expanded ? 'max-h-[2000px] mt-4' : 'max-h-0'}`}
              >
                <div className="grid gap-4 mt-2">
                  {completedProjects.map((project) => {
                    const isCompleted = project.status === "completed";
                    const cardClass = `bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between ${isCompleted ? "opacity-70" : ""}`;
                    const badgeClass = isCompleted
                      ? "text-xs px-2 py-1 rounded-full bg-gray-600 text-gray-200"
                      : `text-xs px-2 py-1 rounded-full ${statusColors[project.status] || "bg-gray-700"}`;

                    return (
                      <article
                        key={project.id}
                        aria-label={`Project ${project.name} ${isCompleted ? "— Completed" : ""}`}
                        className={cardClass}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-3">
                            <h3 className="font-semibold text-lg">{project.name}</h3>
                            <span className={badgeClass}>
                              {statusLabels[project.status] ?? project.status}
                            </span>
                          </div>
                          <p className="text-gray-400 text-sm">{project.description}</p>
                          <p className="text-gray-500 text-xs">
                            Created {new Date(project.createdAt).toLocaleDateString()}
                          </p>
                          {project.lastError && (
                            <p className="text-red-400 text-xs mt-1">{project.lastError}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/projects/${project.id}/chat`}
                            className="text-blue-400 hover:text-blue-300 px-3 py-1 text-sm"
                          >
                            Chat
                          </Link>
                          {(project.status === "awaiting_spec_approval" || project.status === "awaiting_plan_approval") && project.planningPr?.url && (
                            <a
                              href={project.planningPr.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-amber-400 hover:text-amber-300 px-3 py-1 text-sm"
                            >
                              Review PR ↗
                            </a>
                          )}
                          {!isCompleted && (
                            <Link
                              to={`/projects/${project.id}/execute`}
                              className="text-purple-400 hover:text-purple-300 px-3 py-1 text-sm"
                            >
                              Execute
                            </Link>
                          )}
                          {(project.status === "failed" || project.status === "error") && !isCompleted && (
                            <button
                              onClick={() => handleRetry(project.id)}
                              disabled={retrying.has(project.id)}
                              className="text-green-400 hover:text-green-300 disabled:text-gray-600 disabled:cursor-not-allowed px-3 py-1 text-sm"
                            >
                              {retrying.has(project.id) ? "Retrying…" : "Retry"}
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(project.id)}
                            className="text-red-400 hover:text-red-300 px-3 py-1 text-sm"
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Notes:
- The above duplicates the project-card rendering for completed projects to keep the visual parity (opacity-70 etc.).
- The expander button uses aria-expanded and aria-controls for accessibility and a rotating chevron SVG for visual feedback.

- [ ] Step 2: Run the Dashboard unit tests locally to verify behavior

Run:

```bash
cd frontend
npm run test -- src/pages/Dashboard.test.tsx
```

Expected: Tests that previously failed (Task 1) now pass. All tests in the file should PASS.

- [ ] Step 3: If tests fail, iterate (fix small issues), re-run tests until green.

- [ ] Step 4: Commit the implementation

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat(frontend): replace header completed checkbox with expander on Dashboard"
```


### Task 3: Run full frontend test suite

**Files:** N/A

- [ ] Step 1: Run all frontend tests

```bash
cd frontend
npm run test
```

Expected: All frontend tests PASS. If any unrelated failures occur, investigate and adjust only if needed — prefer minimal, targeted fixes and explain in commit message.

- [ ] Step 2: Commit any test fixes separately with clear messages.


### Task 4: Final review & push

- [ ] Step 1: Push branch to remote (create branch beforehand). Use a branch name like `feat/dashboard-completed-expander`.

```bash
git checkout -b feat/dashboard-completed-expander
git push --set-upstream origin feat/dashboard-completed-expander
```

- [ ] Step 2: Open a PR describing the change and link to the spec PR: https://github.com/dreef3/multi-agent-harness/pull/34

PR description should reference the spec file: `docs/superpowers/specs/2026-03-27-completed-projects-expander-design.md` (the spec PR is already open) and this plan: `docs/superpowers/plans/2026-03-27-completed-projects-expander-plan.md`.

- [ ] Step 3: Request review, assign reviewers per repo conventions.


### Task 5: Post-merge cleanup

- [ ] Ensure no linter warnings or TS errors introduced (run local typecheck/build if desired):

```bash
cd frontend
npm run build
```

Expected: Successful build (or fix only if errors introduced by this change).

- [ ] Close the plan PR after merging implementation PR or link to the implementation PR in the plan PR comments.


Testing notes and guidance
- Avoid asserting animation timings in tests; wait for presence/absence of DOM nodes.
- Use accessible queries: findByRole('button', { name: /Show .* completed projects/i }) and getByText for project names.
- Keep commits tiny and test-first: update tests first, then implement.

Commit messages
- Follow conventional commits style used in the repo: `test: ...`, `feat(frontend): ...`

Plan review loop
- After saving this plan, dispatch a single plan-document-reviewer subagent with the following context:
  - Path to plan document (this file): `docs/superpowers/plans/2026-03-27-completed-projects-expander-plan.md`
  - Path to spec document: `docs/superpowers/specs/2026-03-27-completed-projects-expander-design.md` (spec PR: https://github.com/dreef3/multi-agent-harness/pull/34)
  - Request reviewer to verify: completeness, TDD steps, commands, file paths, test coverage, accessibility considerations, and that no backend changes are required.

Execution handoff
- Once plan review passes, implementation sub-agents (or a human) should follow the plan tasks in order. Each task is intentionally small (2–10 minutes).

Plan saved to: `docs/superpowers/plans/2026-03-27-completed-projects-expander-plan.md`


---

Plan complete and saved to `docs/superpowers/plans/2026-03-27-completed-projects-expander-plan.md`. Ready to execute?