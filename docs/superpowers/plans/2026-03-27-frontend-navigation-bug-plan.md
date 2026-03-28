# Chat back navigation & New Project history Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit "Back to projects" control on the Chat page and ensure creating a project from the New Project flow replaces the /projects/new history entry so browser Back goes back to the projects list. Also make the New Project Cancel button navigate deterministically to "/".

**Architecture:** Small, targeted frontend changes in two React pages (Chat and NewProject). These follow existing project patterns (React + react-router-dom + Vitest tests). No backend changes needed.

**Tech Stack:** React, TypeScript, react-router-dom, Vitest, @testing-library/react

---

### File map

- Modify: `frontend/src/pages/Chat.tsx`
  - Add a visible navigation control in the header that navigates to `/`.
  - Preserve existing layout and behavior.

- Modify: `frontend/src/pages/NewProject.tsx`
  - When navigating to the new project's Chat page after creation, call `navigate(..., { replace: true })` so `/projects/new` is removed from history.
  - Change the Cancel button to call `navigate("/")` instead of `navigate(-1)`.

- Add test: `frontend/src/pages/NewProject.test.tsx`
  - Verify project creation triggers navigate with replace: true and that location.state contains the project.
  - Verify Cancel button calls navigate("/").

- Modify test: `frontend/src/pages/Chat.test.tsx` (add one test case)
  - Assert the header contains a link/button that navigates to `/` and has an accessible label/text (e.g., "Back to projects" or "Projects").


### Task 1: Add header navigation to Chat

**Files:**
- Modify: `frontend/src/pages/Chat.tsx`
- Test: Modify `frontend/src/pages/Chat.test.tsx` (add a test)

- [ ] Step 1: Add a failing test that asserts a visible link/button to `/` exists in Chat header.

Add to `frontend/src/pages/Chat.test.tsx` (append a new test block near the top-level describe):

```ts
it('renders a back to projects link in the header', async () => {
  render(
    <MemoryRouter initialEntries={['/project/test-project-id']}>
      <Routes>
        <Route path="/project/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>
  );

  // The link text may be "Back to projects", "Projects", or an icon with aria-label.
  // Use getByRole to prefer an accessible link pointing to '/'.
  const link = await screen.findByRole('link', { name: /projects/i });
  expect(link).toBeInTheDocument();
  // Optional: assert href ends with '/'
  expect((link as HTMLAnchorElement).getAttribute('href')).toBe('/');
});
```

Run:
- `bun run --cwd frontend test -- --run` (or simply `bun run --cwd frontend test`) and verify the new test fails because the markup doesn't exist yet.

- [ ] Step 2: Implement the minimal change in `Chat.tsx`:
  - Import Link from `react-router-dom`.
  - In the header area (where <h1 className="text-2xl font-bold">Chat</h1> is), add a Link before the title: e.g.

```tsx
import { Link } from 'react-router-dom';

// inside JSX header
<div className="flex items-center justify-between">
  <div className="flex items-center gap-3">
    <Link to="/" aria-label="Back to projects" className="text-sm text-blue-400 hover:text-blue-300">
      ← Projects
    </Link>
    <h1 className="text-2xl font-bold">Chat</h1>
  </div>
</div>
```

- [ ] Step 3: Run tests

Command: `bun run --cwd frontend test`
Expected: New header test passes; all existing tests continue to pass.

- [ ] Step 4: Commit changes

```bash
git add frontend/src/pages/Chat.tsx frontend/src/pages/Chat.test.tsx
git commit -m "feat(frontend): add Back to projects link in Chat header and test"
```


### Task 2: Replace history entry when creating project + deterministic Cancel

**Files:**
- Modify: `frontend/src/pages/NewProject.tsx`
- Add test: `frontend/src/pages/NewProject.test.tsx`

Rationale: replace the temporary `/projects/new` entry with the new `/projects/:id/chat` entry so pressing Back does not re-open the New Project form.

- [ ] Step 1: Add a failing test for NewProject behavior.

Create `frontend/src/pages/NewProject.test.tsx` with tests that:
- Mock `api.projects.create` to resolve to a project object { id: 'proj-1', ... }.
- Mock `react-router-dom`'s `useNavigate` to capture calls.
- Render `<NewProject />` and submit the form programmatically (or call the create handler directly), then assert `navigate` was called with the expected path and `replace: true`, and that the passed state contains the created project.
- Also test that clicking Cancel calls `navigate('/')`.

Suggested test content (outline):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../lib/api', () => ({ api: { projects: { create: vi.fn() } } }));

// Tests that after create, navigate called with replace: true and state contains project
// Tests that Cancel calls navigate('/')
```

Run tests and verify they fail initially.

- [ ] Step 2: Implement code changes in `frontend/src/pages/NewProject.tsx`:
  - When creating the project, change:

```ts
navigate(`/projects/${project.id}/chat`, { state: { project } });
```

  to

```ts
navigate(`/projects/${project.id}/chat`, { state: { project }, replace: true });
```

  - Change the Cancel button's onClick from `() => navigate(-1)` to `() => navigate('/')`.
  - Ensure the project object is still passed in location.state so the Chat auto-start behavior remains functional.

- [ ] Step 3: Run tests

Command: `bun run --cwd frontend test`
Expected: New tests pass; no regressions.

- [ ] Step 4: Commit changes

```bash
git add frontend/src/pages/NewProject.tsx frontend/src/pages/NewProject.test.tsx
git commit -m "fix(frontend): replace history entry after project creation; make Cancel deterministic"
```


### Task 3: End-to-end / integration check (optional but recommended)

- [ ] Step 1: Run a manual smoke test in the dev server:
  - Start dev server: `bun run dev` (project root) or `bun run --cwd frontend dev` and backend as needed.
  - In the browser, go to `/`, open New Project, create a project, confirm you land at /projects/{id}/chat, then press the browser Back button — you should return to the projects list and not see the New Project form.

- [ ] Step 2: Add an E2E test (if e2e harness exists) following existing e2e patterns. This is optional now; prioritize unit tests.


### Commit and PR guidance

- Make small commits as indicated above, each with clear messages and scope.
- Push branches and open a PR describing the fix and referencing the spec PR (https://github.com/dreef3/multi-agent-harness/pull/37).


### Plan review

After implementing the plan, update this plan document with the PR URL for the implementation and dispatch a plan-review task to the plan-reviewer sub-agent.

---

Plan author: Planning agent
Spec referenced: docs/superpowers/specs/2026-03-27-chat-back-nav-and-new-project-history-design.md

Plan saved to: docs/superpowers/plans/2026-03-27-chat-back-nav-and-new-project-history-plan.md

Please review and either approve or provide feedback. Once approved I'll dispatch implementation tasks to worker sub-agents.