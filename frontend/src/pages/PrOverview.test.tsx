import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PrOverview from './PrOverview';

interface PrOverride {
  id?: string;
  status?: 'open' | 'merged' | 'declined';
  branch?: string;
  provider?: string;
  url?: string;
  projectId?: string;
  repositoryId?: string;
  agentSessionId?: string;
  externalId?: string;
  createdAt?: string;
  updatedAt?: string;
}

function makePr(overrides: PrOverride = {}) {
  return {
    id: 'pr-1',
    projectId: 'proj-1',
    repositoryId: 'repo-1',
    agentSessionId: 'sess-1',
    provider: 'github',
    externalId: '42',
    url: 'https://github.com/org/repo/pull/42',
    branch: 'feature/task-1',
    status: 'open',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderPrOverview(projectId = 'proj-1') {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/prs`]}>
      <Routes>
        <Route path="/projects/:id/prs" element={<PrOverview />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('PrOverview', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows loading state while fetching', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPrOverview();
    expect(screen.getByText('Loading pull requests...')).toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Internal Server Error' });
    renderPrOverview();
    await waitFor(() => expect(screen.getByText(/Error:/)).toBeInTheDocument());
  });

  it('shows empty state when no pull requests exist', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    renderPrOverview();
    await waitFor(() =>
      expect(screen.getByText(/No pull requests yet/)).toBeInTheDocument()
    );
  });

  it('renders a pull request card with branch and status', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makePr()] });
    renderPrOverview();
    await waitFor(() => expect(screen.getByText(/feature\/task-1/)).toBeInTheDocument());
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it('Fix Now button is disabled for merged PRs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makePr({ status: 'merged' })] });
    renderPrOverview();
    await waitFor(() => expect(screen.getByRole('button', { name: /Fix Now/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Fix Now/i })).toBeDisabled();
  });

  it('Fix Now button is enabled for open PRs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makePr({ status: 'open' })] });
    renderPrOverview();
    await waitFor(() => expect(screen.getByRole('button', { name: /Fix Now/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Fix Now/i })).not.toBeDisabled();
  });

  it('Sync Comments button calls the sync endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [makePr()] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ synced: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [makePr()] });
    renderPrOverview();
    const syncBtn = await screen.findByRole('button', { name: /Sync Comments/i });
    fireEvent.click(syncBtn);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/sync'),
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it('Refresh button re-fetches pull requests', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    renderPrOverview();
    await waitFor(() => screen.getByRole('button', { name: /Refresh/i }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
