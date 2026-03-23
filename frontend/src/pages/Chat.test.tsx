import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Chat from './Chat';
import type { Message } from '../lib/api';

// Store the message handler for testing - using a module-level object to persist across mocks
const handlerStorage: { handler: ((data: unknown) => void) | null } = { handler: null };

// Mock dependencies
vi.mock('../lib/api', () => {
  return {
    api: {
      projects: {
        messages: {
          list: vi.fn().mockResolvedValue([]),
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
      onMessage: vi.fn((handler: (data: unknown) => void) => {
        handlerStorage.handler = handler;
        return () => { handlerStorage.handler = null; };
      }),
    },
  };
});

describe('Chat Component State Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlerStorage.handler = null;
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

  describe('WebSocket replay handler', () => {
    it('should merge replay messages with existing messages', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );
      
      // Wait for component to mount and register handler
      await waitFor(() => {
        expect(handlerStorage.handler).toBeDefined();
      }, { timeout: 2000 });
      
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      }, { timeout: 2000 });
      
      // Send a replay message with new messages
      const replayMessages: Message[] = [
        { id: '1', projectId: 'test', role: 'user', content: 'Hello', timestamp: '2024-01-01', seqId: 1 },
        { id: '2', projectId: 'test', role: 'assistant', content: 'Hi there', timestamp: '2024-01-01', seqId: 2 },
      ];
      
      await act(async () => {
        handlerStorage.handler?.({ type: 'replay', messages: replayMessages });
      });
      
      // Verify messages are displayed
      await waitFor(() => {
        expect(screen.getByText('Hello')).toBeInTheDocument();
        expect(screen.getByText('Hi there')).toBeInTheDocument();
      });
    });

    it('should deduplicate replay messages by seqId', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );
      
      // Wait for component to mount and register handler
      await waitFor(() => {
        expect(handlerStorage.handler).toBeDefined();
      }, { timeout: 2000 });
      
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      }, { timeout: 2000 });
      
      // First replay with seqId 1
      const firstReplay: Message[] = [
        { id: '1', projectId: 'test', role: 'user', content: 'First', timestamp: '2024-01-01', seqId: 1 },
      ];
      
      await act(async () => {
        handlerStorage.handler?.({ type: 'replay', messages: firstReplay });
      });
      
      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });
      
      // Second replay with seqId 1 (duplicate) and seqId 2 (new)
      const secondReplay: Message[] = [
        { id: '1', projectId: 'test', role: 'user', content: 'First', timestamp: '2024-01-01', seqId: 1 },
        { id: '2', projectId: 'test', role: 'assistant', content: 'Second', timestamp: '2024-01-01', seqId: 2 },
      ];
      
      await act(async () => {
        handlerStorage.handler?.({ type: 'replay', messages: secondReplay });
      });
      
      // Should still only have "First" once, but should now have "Second"
      await waitFor(() => {
        const firstElements = screen.getAllByText('First');
        expect(firstElements).toHaveLength(1);
        expect(screen.getByText('Second')).toBeInTheDocument();
      });
    });

    it('should sort merged messages by seqId', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );
      
      // Wait for component to mount and register handler
      await waitFor(() => {
        expect(handlerStorage.handler).toBeDefined();
      }, { timeout: 2000 });
      
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      }, { timeout: 2000 });
      
      // Send replay messages out of order
      const replayMessages: Message[] = [
        { id: '3', projectId: 'test', role: 'assistant', content: 'Third', timestamp: '2024-01-01', seqId: 3 },
        { id: '1', projectId: 'test', role: 'user', content: 'First', timestamp: '2024-01-01', seqId: 1 },
        { id: '2', projectId: 'test', role: 'assistant', content: 'Second', timestamp: '2024-01-01', seqId: 2 },
      ];
      
      await act(async () => {
        handlerStorage.handler?.({ type: 'replay', messages: replayMessages });
      });
      
      // Verify messages appear in seqId order
      const messageContainer = document.querySelector('.space-y-3');
      const messageContents = Array.from(messageContainer?.querySelectorAll('.prose') || []).map(el => el.textContent);
      
      // Messages should be sorted: First (seqId 1), Second (seqId 2), Third (seqId 3)
      expect(messageContents).toEqual(['First', 'Second', 'Third']);
    });

    it('should not update state when all replay messages are duplicates', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );
      
      // Wait for component to mount and register handler
      await waitFor(() => {
        expect(handlerStorage.handler).toBeDefined();
      }, { timeout: 2000 });
      
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      }, { timeout: 2000 });
      
      // First replay
      const firstReplay: Message[] = [
        { id: '1', projectId: 'test', role: 'user', content: 'Hello', timestamp: '2024-01-01', seqId: 1 },
      ];
      
      await act(async () => {
        handlerStorage.handler?.({ type: 'replay', messages: firstReplay });
      });
      
      await waitFor(() => {
        expect(screen.getByText('Hello')).toBeInTheDocument();
      });
      
      // Get message count after first replay
      const messagesAfterFirst = document.querySelectorAll('.prose').length;
      
      // Second replay with all duplicates
      const duplicateReplay: Message[] = [
        { id: '1', projectId: 'test', role: 'user', content: 'Hello', timestamp: '2024-01-01', seqId: 1 },
      ];
      
      await act(async () => {
        handlerStorage.handler?.({ type: 'replay', messages: duplicateReplay });
      });
      
      // Small delay to ensure no re-render
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Message count should be unchanged
      expect(document.querySelectorAll('.prose').length).toBe(messagesAfterFirst);
    });
  });
});
