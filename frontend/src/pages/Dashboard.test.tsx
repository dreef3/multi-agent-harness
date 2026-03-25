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
});
