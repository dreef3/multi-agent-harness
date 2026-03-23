import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Chat from './Chat';

// Mock dependencies
vi.mock('../lib/api', () => {
  return {
    api: {
      projects: {
        messages: {
          list: vi.fn(),
        },
      },
    },
  };
});

vi.mock('../lib/ws', () => {
  return {
    wsClient: {
      setProjectId: vi.fn(),
      connect: vi.fn(),
      send: vi.fn(),
      onConnect: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
    },
  };
});

describe('Chat Component State Management', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Get the mocked modules
    const apiModule = await import('../lib/api');
    const wsModule = await import('../lib/ws');
    
    // Setup mock to return empty messages
    const mockListMessages = apiModule.api.projects.messages.list as ReturnType<typeof vi.fn>;
    mockListMessages.mockResolvedValue([]);
    
    // Setup wsClient mocks
    (wsModule.wsClient.setProjectId as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (wsModule.wsClient.connect as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (wsModule.wsClient.onConnect as ReturnType<typeof vi.fn>).mockReturnValue(() => {});
    (wsModule.wsClient.onMessage as ReturnType<typeof vi.fn>).mockReturnValue(() => {});
  });

  describe('isLoadingMessages state', () => {
    it('should initialize with isLoadingMessages set to true', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );
      
      // Initially shows loading state within the messages area
      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
      
      // Wait for loading to complete
      await waitFor(() => {
        expect(screen.queryByTestId('loading-indicator')).not.toBeInTheDocument();
      }, { timeout: 2000 });
    });

    it('should show empty state only when NOT loading and no messages', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );

      // While loading, should NOT show empty state
      expect(screen.queryByText('No messages yet. Start the conversation!')).not.toBeInTheDocument();

      // Wait for loading to complete
      await waitFor(() => {
        expect(screen.getByText('No messages yet. Start the conversation!')).toBeInTheDocument();
      }, { timeout: 2000 });
    });
  });
});
