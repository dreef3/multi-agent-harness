import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewProject from './NewProject';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../lib/api', () => {
  return {
    api: {
      repositories: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'repo-1',
            name: 'Repo 1',
            cloneUrl: 'https://example.com/repo.git',
            provider: 'github',
            providerConfig: {},
            defaultBranch: 'main',
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
          },
        ]),
      },
      projects: {
        create: vi.fn().mockResolvedValue({
          id: 'proj-1',
          name: 'Test Project',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          status: 'draft',
        }),
      },
    },
  };
});

describe('NewProject navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to new project chat with replace: true and passes project in state after creation', async () => {
    render(<NewProject />);

    // Wait for repositories to load and the select button to be available
    const selectButton = await screen.findByRole('button', { name: /select repositories/i });
    fireEvent.click(selectButton);

    // Click on the repository entry
    const repoButton = await screen.findByRole('button', { name: /Repo 1/i });
    fireEvent.click(repoButton);

    // Fill project name
    const nameInput = screen.getByPlaceholderText('My Awesome Project');
    fireEvent.change(nameInput, { target: { value: 'My Test Project' } });

    // Submit the form
    const createButton = screen.getByRole('button', { name: /create project/i });
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });

    // assert navigate called with path and options
    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/chat', {
      state: { project: expect.objectContaining({ id: 'proj-1' }) },
      replace: true,
    });
  });

  it('calls navigate("/") when Cancel is clicked', async () => {
    render(<NewProject />);

    // Wait for repositories to load
    await screen.findByRole('button', { name: /select repositories/i });

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
