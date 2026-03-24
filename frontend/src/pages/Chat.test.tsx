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
      disconnect: vi.fn(),
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
    it('should show empty state while loading initially', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );
      
      // Initially shows empty state while loading (not a blocking loading screen)
      expect(screen.getByText('No messages yet. Start the conversation!')).toBeInTheDocument();
      
      // Wait for loading to complete
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      }, { timeout: 2000 });
    });

    it('should show empty state while loading and after when no messages', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );

      // While loading, should show empty state (not blocking loading screen)
      expect(screen.getByText('No messages yet. Start the conversation!')).toBeInTheDocument();

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

  describe('project navigation', () => {
    it('clears messages when project id changes', async () => {
      const { api } = await import('../lib/api');
      const mockList = vi.mocked(api.projects.messages.list);

      // Project A returns one message
      mockList.mockResolvedValueOnce([
        { id: '1', projectId: 'project-a', role: 'user' as const, content: 'Hello from A', timestamp: '2024-01-01', seqId: 1 },
      ]);

      const { rerender } = render(
        <MemoryRouter key="project-a" initialEntries={['/project/project-a']}>
          <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
        </MemoryRouter>
      );

      await waitFor(() => expect(screen.getByText('Hello from A')).toBeInTheDocument());

      // Navigate to project B (no messages)
      mockList.mockResolvedValue([]);
      rerender(
        <MemoryRouter key="project-b" initialEntries={['/project/project-b']}>
          <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
        </MemoryRouter>
      );

      await waitFor(() => expect(screen.queryByText('Hello from A')).not.toBeInTheDocument());
    });
  });

  describe('message deduplication', () => {
    it('does not duplicate user message after loadMessages', async () => {
      const { api } = await import('../lib/api');
      const mockList = vi.mocked(api.projects.messages.list);

      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
        </MemoryRouter>
      );
      await waitFor(() => expect(handlerStorage.handler).toBeDefined());

      // loadMessages returns the DB version of the user's message
      mockList.mockResolvedValueOnce([
        { id: '10', projectId: 'test', role: 'user' as const, content: 'My message', timestamp: '2024-01-01', seqId: 1 },
      ]);

      // message_complete triggers loadMessages
      await act(async () => {
        handlerStorage.handler?.({ type: 'message_complete' });
      });

      await waitFor(() => {
        expect(screen.queryAllByText('My message')).toHaveLength(1);
      });
    });
  });

  describe('tool call display', () => {
    it('shows tool call card when tool_call event received during processing', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
        </MemoryRouter>
      );
      await waitFor(() => expect(handlerStorage.handler).toBeDefined());

      await act(async () => {
        // delta sets thinkingMode to "typing"
        handlerStorage.handler?.({ type: 'delta', text: 'thinking...' });
      });
      await act(async () => {
        handlerStorage.handler?.({ type: 'tool_call', toolName: 'read_file', args: { path: '/foo.ts' }, agentType: 'master' });
      });

      await waitFor(() => expect(screen.getByText('read_file')).toBeInTheDocument());
    });

    it('shows +N more badge after multiple tool calls', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
        </MemoryRouter>
      );
      await waitFor(() => expect(handlerStorage.handler).toBeDefined());

      await act(async () => {
        handlerStorage.handler?.({ type: 'delta', text: 'x' });
        handlerStorage.handler?.({ type: 'tool_call', toolName: 'tool_1', args: {}, agentType: 'master' });
        handlerStorage.handler?.({ type: 'tool_call', toolName: 'tool_2', args: {}, agentType: 'master' });
        handlerStorage.handler?.({ type: 'tool_call', toolName: 'tool_3', args: {}, agentType: 'master' });
      });

      await waitFor(() => expect(screen.getByText('+2 more')).toBeInTheDocument());
    });

    it('clears tool call card on conversation_complete', async () => {
      render(
        <MemoryRouter initialEntries={['/project/test-project-id']}>
          <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
        </MemoryRouter>
      );
      await waitFor(() => expect(handlerStorage.handler).toBeDefined());

      await act(async () => {
        handlerStorage.handler?.({ type: 'delta', text: 'x' });
        handlerStorage.handler?.({ type: 'tool_call', toolName: 'read_file', args: {}, agentType: 'master' });
      });
      await waitFor(() => expect(screen.getByText('read_file')).toBeInTheDocument());

      await act(async () => {
        handlerStorage.handler?.({ type: 'conversation_complete' });
      });

      await waitFor(() => expect(screen.queryByText('read_file')).not.toBeInTheDocument());
    });
  });

  describe('WebSocket lifecycle', () => {
    it('disconnects WebSocket when navigating away from a project', async () => {
      const { wsClient } = await import('../lib/ws');
      const { unmount } = render(
        <MemoryRouter initialEntries={['/project/project-a']}>
          <Routes>
            <Route path="/project/:id" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      );

      unmount();

      expect(wsClient.disconnect).toHaveBeenCalledOnce();
    });
  });
});
