import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';
import type { Repository } from '../lib/api';

vi.mock('../lib/api', () => ({
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

vi.mock('../components/RepositoryForm', () => ({
  default: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      <span>RepositoryForm</span>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

const defaultConfig = {
  provider: 'anthropic',
  models: {
    masterAgent: { model: 'claude-3-5-sonnet', temperature: 0.7, maxTokens: 4096 },
    workerAgent: { model: 'claude-3-5-haiku', temperature: 0.5, maxTokens: 2048 },
  },
};

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'repo-1',
    name: 'my-repo',
    cloneUrl: 'https://github.com/org/my-repo.git',
    provider: 'github',
    providerConfig: { owner: 'org', repo: 'my-repo' },
    defaultBranch: 'main',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderSettings() {
  return render(<MemoryRouter><Settings /></MemoryRouter>);
}

describe('Settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Settings and Repositories headings', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue(defaultConfig);
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Settings$/i })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /^Repositories$/i })).toBeInTheDocument();
  });

  it('shows OpenCode banner when provider starts with opencode', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue({ ...defaultConfig, provider: 'opencode-go' });
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText(/Using OpenCode provider/)).toBeInTheDocument()
    );
  });

  it('does not show OpenCode banner for non-opencode provider', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue(defaultConfig);
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Settings$/i })).toBeInTheDocument());
    expect(screen.queryByText(/Using OpenCode provider/)).not.toBeInTheDocument();
  });

  it('disables model text inputs when provider is opencode', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue({ ...defaultConfig, provider: 'opencode-go' });
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    await waitFor(() => expect(screen.getByText(/Using OpenCode provider/)).toBeInTheDocument());
    const textInputs = screen.getAllByRole('textbox');
    for (const input of textInputs) {
      expect(input).toBeDisabled();
    }
  });

  it('Save Settings button shows success message on click', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue(defaultConfig);
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    const saveBtn = await screen.findByRole('button', { name: /Save Settings/i });
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(screen.getByText(/Settings saved successfully/i)).toBeInTheDocument()
    );
  });

  it('renders repository list with name and clone URL', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue(defaultConfig);
    vi.mocked(api.repositories.list).mockResolvedValue([makeRepo()]);
    renderSettings();
    await waitFor(() => expect(screen.getByText('my-repo')).toBeInTheDocument());
    expect(screen.getByText('https://github.com/org/my-repo.git')).toBeInTheDocument();
  });

  it('opens Add Repository modal when button is clicked', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue(defaultConfig);
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    const addBtn = await screen.findByRole('button', { name: /\+ Add Repository/i });
    fireEvent.click(addBtn);
    expect(screen.getByText('Add Repository')).toBeInTheDocument();
    expect(screen.getByText('RepositoryForm')).toBeInTheDocument();
  });

  it('closes Add Repository modal when Cancel is clicked', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.config).mockResolvedValue(defaultConfig);
    vi.mocked(api.repositories.list).mockResolvedValue([]);
    renderSettings();
    const addBtn = await screen.findByRole('button', { name: /\+ Add Repository/i });
    fireEvent.click(addBtn);
    expect(screen.getByText('RepositoryForm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() =>
      expect(screen.queryByText('RepositoryForm')).not.toBeInTheDocument()
    );
  });
});
