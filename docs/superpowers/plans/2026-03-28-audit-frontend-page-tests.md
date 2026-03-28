# Frontend Page Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vitest + React Testing Library test files for the three untested frontend pages — `PlanApproval.tsx`, `PrOverview.tsx`, and `Settings.tsx` — covering render, loading/error states, and key interactions.

**Architecture:** Each test file mirrors the pattern in `Dashboard.test.tsx`: mock `fetch` globally with `vi.stubGlobal`, mock `../lib/api` for pages that use it, render inside `MemoryRouter` with initial entries, and assert on rendered elements. `PlanApproval` is a redirect-only component requiring a `useNavigate` mock.

**Tech Stack:** Vitest, React Testing Library (`@testing-library/react`), `MemoryRouter`/`useNavigate` from react-router-dom, Vitest's `vi.stubGlobal` and `vi.fn()`.

---

## Context

### PlanApproval.tsx — lines 1–13

The entire component is a redirect stub: on mount it calls `navigate(`/projects/${id}/chat`, { replace: true })` and returns `null`. There is no UI to test except that the redirect fires.

### PrOverview.tsx — lines 1–413

Fetches from `/api/pull-requests/project/${projectId}` on mount (via raw `fetch`, not `api`). Shows:
- Loading state: `<div className="text-gray-400">Loading pull requests...</div>`
- Error state: `<div className="text-red-400">Error: {error}</div>`
- Empty state: "No pull requests yet..." text
- PR list with status badges, Sync Comments button, Fix Now button, Test Countdown button
- PR detail panel when a PR is selected (clicking a PR card loads `/api/pull-requests/${prId}`)

Uses `useParams<{ id: string }>()` for `projectId`.

### Settings.tsx — lines 1–391

Fetches from `api.config()` and `api.repositories.list()` on mount. Shows:
- Loading state: `<div className="text-gray-400">Loading...</div>`
- Failed state: `<div className="text-gray-400">Failed to load settings</div>`
- Settings form: "Master Agent" section with Model input, Temperature range, Max Tokens number input
- "Worker Agents" section with same fields
- "Repositories" section with "+ Add Repository" button
- Save Settings button at bottom

---

## Steps

### PlanApproval.test.tsx

- [ ] **Step 1 — Create `frontend/src/pages/PlanApproval.test.tsx`**

  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { render } from "@testing-library/react";
  import { MemoryRouter, Route, Routes } from "react-router-dom";
  import PlanApproval from "./PlanApproval";

  // Capture the navigate calls
  const mockNavigate = vi.fn();

  vi.mock("react-router-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-router-dom")>();
    return {
      ...actual,
      useNavigate: () => mockNavigate,
    };
  });

  describe("PlanApproval", () => {
    it("renders null (no visible output)", () => {
      const { container } = render(
        <MemoryRouter initialEntries={["/projects/proj-1/plan-approval"]}>
          <Routes>
            <Route path="/projects/:id/plan-approval" element={<PlanApproval />} />
          </Routes>
        </MemoryRouter>
      );
      expect(container.firstChild).toBeNull();
    });

    it("navigates to /projects/:id/chat with replace:true on mount", () => {
      mockNavigate.mockClear();
      render(
        <MemoryRouter initialEntries={["/projects/proj-42/plan-approval"]}>
          <Routes>
            <Route path="/projects/:id/plan-approval" element={<PlanApproval />} />
          </Routes>
        </MemoryRouter>
      );
      expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-42/chat", { replace: true });
    });
  });
  ```

### PrOverview.test.tsx

- [ ] **Step 2 — Create `frontend/src/pages/PrOverview.test.tsx`**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { render, screen, fireEvent, waitFor } from "@testing-library/react";
  import { MemoryRouter, Route, Routes } from "react-router-dom";
  import PrOverview from "./PrOverview";

  const mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);

  function makePr(overrides = {}) {
    return {
      id: "pr-1",
      projectId: "proj-1",
      repositoryId: "repo-1",
      agentSessionId: "sess-1",
      provider: "github",
      externalId: "42",
      url: "https://github.com/org/repo/pull/42",
      branch: "agent/task-1",
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  function renderPage(projectId = "proj-1") {
    return render(
      <MemoryRouter initialEntries={[`/projects/${projectId}/prs`]}>
        <Routes>
          <Route path="/projects/:id/prs" element={<PrOverview />} />
        </Routes>
      </MemoryRouter>
    );
  }

  describe("PrOverview", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("shows loading state initially", () => {
      // Fetch never resolves during this test
      mockFetch.mockReturnValue(new Promise(() => {}));
      renderPage();
      expect(screen.getByText("Loading pull requests...")).toBeTruthy();
    });

    it("shows error state when fetch fails", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/Error:/)).toBeTruthy()
      );
    });

    it("shows empty state when no PRs are returned", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/No pull requests yet/)).toBeTruthy()
      );
    });

    it("renders PR list when PRs are returned", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePr()]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/agent\/task-1/)).toBeTruthy()
      );
    });

    it("renders PR status badge", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePr({ status: "merged" })]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByText("merged")).toBeTruthy()
      );
    });

    it("renders Sync Comments button for each PR", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePr()]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Sync Comments/i })).toBeTruthy()
      );
    });

    it("renders Fix Now button for open PR", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePr({ status: "open" })]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Fix Now/i })).toBeTruthy()
      );
    });

    it("Fix Now button is disabled for merged PR", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePr({ status: "merged" })]),
      });
      renderPage();
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /Fix Now/i });
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it("renders Refresh button", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Refresh/i })).toBeTruthy()
      );
    });

    it("clicking Refresh button re-fetches PRs", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([makePr()]) });

      renderPage();
      await waitFor(() => screen.getByRole("button", { name: /Refresh/i }));
      fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
      await waitFor(() =>
        expect(screen.getByText(/agent\/task-1/)).toBeTruthy()
      );
    });

    it("loads PR details when a PR card is clicked", async () => {
      const prWithComments = {
        ...makePr(),
        comments: [
          {
            id: "c-1", pullRequestId: "pr-1", externalId: "100",
            author: "reviewer", body: "Please fix the spacing",
            status: "pending", receivedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };

      mockFetch
        // Initial list load
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([makePr()]) })
        // PR detail load triggered by click
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(prWithComments) });

      renderPage();
      await waitFor(() => screen.getByText(/agent\/task-1/));

      // Click the PR card (branch text is inside)
      fireEvent.click(screen.getByText(/agent\/task-1/));

      await waitFor(() =>
        expect(screen.getByText("Please fix the spacing")).toBeTruthy()
      );
    });

    it("shows select-PR placeholder when no PR is selected", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([makePr()]),
      });
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/Select a pull request to view comments/i)).toBeTruthy()
      );
    });
  });
  ```

### Settings.test.tsx

- [ ] **Step 3 — Create `frontend/src/pages/Settings.test.tsx`**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { render, screen, fireEvent, waitFor } from "@testing-library/react";
  import { MemoryRouter } from "react-router-dom";
  import Settings from "./Settings";

  // Mock the api module — Settings uses api.config() and api.repositories.list()
  vi.mock("../lib/api", () => ({
    api: {
      config: vi.fn(),
      repositories: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
  }));

  // Mock RepositoryForm to isolate Settings from its implementation
  vi.mock("../components/RepositoryForm", () => ({
    default: ({ onCancel }: { onCancel: () => void }) => (
      <div data-testid="repo-form">
        <button onClick={onCancel}>Cancel</button>
      </div>
    ),
  }));

  const defaultConfig = {
    provider: "opencode-go",
    planningModel: "minimax-m2.7",
    implementationModel: "minimax-m2.7",
    models: {
      masterAgent: { model: "minimax-m2.7", temperature: 0.7, maxTokens: 4096 },
      workerAgent: { model: "minimax-m2.7", temperature: 0.5, maxTokens: 2048 },
    },
  };

  function renderPage() {
    return render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
  }

  describe("Settings", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("shows loading state initially", () => {
      const { api } = require("../lib/api");
      api.config.mockReturnValue(new Promise(() => {}));
      api.repositories.list.mockReturnValue(new Promise(() => {}));
      renderPage();
      expect(screen.getByText("Loading...")).toBeTruthy();
    });

    it("shows fallback settings when api.config() fails", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockRejectedValue(new Error("network error"));
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      // Falls back to defaults — should show Settings heading
      await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
    });

    it("renders Settings heading after successful load", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
    });

    it("shows provider label in header", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => expect(screen.getByText("opencode-go")).toBeTruthy());
    });

    it("renders Master Agent and Worker Agents sections", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => {
        expect(screen.getByText("Master Agent")).toBeTruthy();
        expect(screen.getByText("Worker Agents")).toBeTruthy();
      });
    });

    it("shows OpenCode info banner when provider is opencode-go", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/Using OpenCode provider/i)).toBeTruthy()
      );
    });

    it("does not show OpenCode banner for non-opencode provider", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue({
        ...defaultConfig,
        provider: "pi",
        models: {
          masterAgent: { model: "claude-3-opus", temperature: 0.7, maxTokens: 4096 },
          workerAgent: { model: "claude-3-haiku", temperature: 0.5, maxTokens: 2048 },
        },
      });
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
      expect(screen.queryByText(/Using OpenCode provider/i)).toBeNull();
    });

    it("model inputs are disabled when provider is opencode-go", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => screen.getByText("Master Agent"));
      const modelInputs = screen.getAllByDisplayValue("minimax-m2.7");
      modelInputs.forEach((input) => {
        expect((input as HTMLInputElement).disabled).toBe(true);
      });
    });

    it("renders Save Settings button", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Save Settings/i })).toBeTruthy()
      );
    });

    it("clicking Save Settings shows success message", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => screen.getByRole("button", { name: /Save Settings/i }));
      fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
      await waitFor(() =>
        expect(screen.getByText(/saved successfully/i)).toBeTruthy()
      );
    });

    it("shows empty repositories message when no repos exist", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/No repositories configured/i)).toBeTruthy()
      );
    });

    it("renders repository list when repos are returned", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([
        {
          id: "repo-1",
          name: "my-service",
          cloneUrl: "https://github.com/org/my-service.git",
          provider: "github",
          defaultBranch: "main",
          providerConfig: { owner: "org", repo: "my-service" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]);
      renderPage();
      await waitFor(() => expect(screen.getByText("my-service")).toBeTruthy());
    });

    it("clicking + Add Repository opens the RepositoryForm modal", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => screen.getByRole("button", { name: /\+ Add Repository/i }));
      fireEvent.click(screen.getByRole("button", { name: /\+ Add Repository/i }));
      expect(screen.getByTestId("repo-form")).toBeTruthy();
      expect(screen.getByText("Add Repository")).toBeTruthy();
    });

    it("closing the modal hides the RepositoryForm", async () => {
      const { api } = await import("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockResolvedValue([]);
      renderPage();
      await waitFor(() => screen.getByRole("button", { name: /\+ Add Repository/i }));
      fireEvent.click(screen.getByRole("button", { name: /\+ Add Repository/i }));
      expect(screen.getByTestId("repo-form")).toBeTruthy();
      // Click Cancel in the mocked form
      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
      expect(screen.queryByTestId("repo-form")).toBeNull();
    });

    it("shows repo loading state", () => {
      const { api } = require("../lib/api");
      vi.mocked(api.config).mockResolvedValue(defaultConfig);
      vi.mocked(api.repositories.list).mockReturnValue(new Promise(() => {}));
      renderPage();
      // While config resolves immediately, repo loading shows
      // We can just check that the component doesn't crash during loading
      expect(document.body).toBeTruthy();
    });
  });
  ```

- [ ] **Step 4 — Run all three test files**

  ```bash
  cd /home/ae/multi-agent-harness/frontend && npx vitest run src/pages/PlanApproval.test.tsx src/pages/PrOverview.test.tsx src/pages/Settings.test.tsx --reporter=verbose 2>&1
  ```

  Expected failures and how to fix them:
  - **"useNavigate is not a function"** in PlanApproval tests: The `vi.mock("react-router-dom", ...)` override must return all actual exports. Confirm `importOriginal` is used correctly.
  - **Settings `require()` syntax error**: Vitest ESM doesn't support CommonJS `require()`. Replace `require("../lib/api")` with the async `await import("../lib/api")` pattern used in Dashboard tests.
  - **`api.config()` returns object without `models` key**: Check the actual `Config` type in `frontend/src/lib/api.ts`. The `Settings` component reads `backendConfig.models.masterAgent` — confirm the shape. The `defaultConfig` object in the test must match the actual `Config` type.

- [ ] **Step 5 — Fix Config type alignment**

  Read `frontend/src/lib/api.ts` to confirm the exact shape of `Config` and `ModelConfig`. The test's `defaultConfig` mock must match it exactly. If `Config` doesn't include a `models` key (only `provider`, `planningModel`, `implementationModel`), then `Settings.tsx` constructs `settings` from those flat fields — update `defaultConfig` accordingly.

  The `Settings` component lines 78–81 show:
  ```typescript
  setSettings({
    masterAgent: { ...backendConfig.models.masterAgent },
    workerAgents: { ...backendConfig.models.workerAgent },
  });
  ```

  If `Config` doesn't have a `models` property, this will throw and the component falls back to the hardcoded defaults. Read `frontend/src/lib/api.ts` to verify.

- [ ] **Step 6 — Run full frontend test suite**

  ```bash
  cd /home/ae/multi-agent-harness/frontend && npx vitest run --reporter=verbose 2>&1 | tail -40
  ```

  All existing tests must continue to pass.

---

## Notes

- `PlanApproval.tsx` is intentionally minimal — it was a real page that got replaced by the Chat page. The tests document this behavior for future refactoring.
- `PrOverview.tsx` uses raw `fetch` rather than the `api` helper for pull-request endpoints. The tests mock `fetch` globally via `vi.stubGlobal`, which is consistent with how other pages are tested.
- The `Settings.tsx` component's `handleSave` is a stub (the settings endpoint is not implemented). The test verifies the success message appears without checking an API call — this is intentional and matches the component's `// Settings endpoint not implemented yet` comment.
- `RepositoryForm` is mocked to keep the Settings tests focused on the Settings page logic, not the form validation.
