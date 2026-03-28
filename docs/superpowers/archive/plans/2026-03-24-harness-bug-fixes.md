# Harness Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 bugs covering chat correctness, React performance, planning agent lifecycle, execution navigation, tool call visibility, project recovery, and Docker cleanup.

**Architecture:** Tasks 1–4 are fully independent (no shared files) and MUST be dispatched in parallel. Task 5 runs only after Tasks 1 and 4 complete — it modifies `Chat.tsx` (owned by Task 1) and uses the retry API endpoint (added by Task 4). `planningAgentManager.ts` is owned exclusively by Task 2. `websocket.ts` is owned exclusively by Task 5.

**Tech Stack:** React 18 + TypeScript (frontend), Express + TypeScript + SQLite/better-sqlite3 (backend), Vitest + @testing-library/react (tests), Dockerode (Docker management).

**Spec:** `docs/superpowers/specs/2026-03-24-harness-bug-fixes-design.md`

---

## File Structure

| File | Task | Change |
|------|------|--------|
| `frontend/src/pages/Chat.tsx` | 1, then 5 | State reset, dedup, React.memo, tool calls (T1); retry banner (T5) |
| `frontend/src/pages/Chat.test.tsx` | 1 | New tests |
| `frontend/src/pages/Execution.tsx` | 3 | Add AgentPicker, replace pill container |
| `frontend/src/pages/Execution.test.tsx` | 3 | New test file |
| `frontend/src/pages/Dashboard.tsx` | 5 | Retry button + lastError display |
| `frontend/src/pages/Dashboard.test.tsx` | 5 | New test file |
| `frontend/src/lib/api.ts` | 5 | Add `projects.retry()` |
| `backend/src/models/types.ts` | 4 | Add `lastError?: string` to Project |
| `backend/src/store/db.ts` | 4 | Add `last_error` column migration |
| `backend/src/store/projects.ts` | 4 | Serialize/deserialize `lastError` |
| `backend/src/api/projects.ts` | 4 | Add `POST /:id/retry` endpoint |
| `backend/src/api/websocket.ts` | 5 | WS retry loop on `ensureRunning` failure |
| `backend/src/orchestrator/planningAgentManager.ts` | 2 | Lifecycle state machine + docker cleanup |
| `backend/src/__tests__/planningAgentManager.test.ts` | 2 | New tests |
| `backend/src/__tests__/projects.test.ts` | 4 | New retry endpoint tests |

---

## Parallel Execution

```
Parallel batch:  Task 1 ──┐
                 Task 2   ├──► Task 5
                 Task 3   │
                 Task 4 ──┘
```

---

## Task 1: Chat Improvements — Bugs 1, 2, 5

**Files:**
- Modify: `frontend/src/pages/Chat.tsx`
- Modify: `frontend/src/pages/Chat.test.tsx`

**Context before starting:** Read `frontend/src/pages/Chat.tsx` and `frontend/src/pages/Chat.test.tsx` in full. Tests use `vi.mock('../lib/api')` and `vi.mock('../lib/ws')`, storing the WS message handler in `handlerStorage.handler`. Follow the same mock pattern.

**Run tests:** `cd /home/ae/multi-agent-harness/frontend && npm test -- --run Chat`

---

- [ ] **Step 1: Write failing test — state resets when project changes (Bug 1a)**

Add this `describe` block inside `describe('Chat Component State Management')` in `frontend/src/pages/Chat.test.tsx`:

```typescript
describe('project navigation', () => {
  it('clears messages when project id changes', async () => {
    const { api } = await import('../lib/api');
    const mockList = vi.mocked(api.projects.messages.list);

    // Project A returns one message
    mockList.mockResolvedValueOnce([
      { id: '1', projectId: 'project-a', role: 'user' as const, content: 'Hello from A', timestamp: '2024-01-01', seqId: 1 },
    ]);

    const { rerender } = render(
      <MemoryRouter initialEntries={['/project/project-a']}>
        <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Hello from A')).toBeInTheDocument());

    // Navigate to project B (no messages)
    mockList.mockResolvedValue([]);
    rerender(
      <MemoryRouter initialEntries={['/project/project-b']}>
        <Routes><Route path="/project/:id" element={<Chat />} /></Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.queryByText('Hello from A')).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Chat
```

Expected: FAIL — "Hello from A" remains visible after navigation

---

- [ ] **Step 3: Write failing test — no duplicate messages (Bug 1b)**

Add inside `describe('Chat Component State Management')`:

```typescript
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
```

- [ ] **Step 4: Run test, verify it fails**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Chat
```

Expected: FAIL (with current merge logic, duplicates are possible)

---

- [ ] **Step 5: Write failing tests — tool call display (Bug 5)**

Add inside `describe('Chat Component State Management')`:

```typescript
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
```

- [ ] **Step 6: Run tests, verify they fail**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Chat
```

Expected: FAIL — ToolCallCard not implemented

---

- [ ] **Step 7: Replace `frontend/src/pages/Chat.tsx` with fixed implementation**

```typescript
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, Message, Project } from "../lib/api";
import { wsClient } from "../lib/ws";

type ThinkingMode = "none" | "typing" | "processing";

interface ToolEvent {
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

// Memoised — only re-renders when its own message prop changes.
// This prevents ReactMarkdown from re-running on every streaming delta.
const MessageBubble = React.memo(function MessageBubble({ msg }: { msg: Message }) {
  return (
    <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
      <div
        data-testid={msg.role === "assistant" ? "assistant-message" : undefined}
        className={`max-w-[80%] rounded-lg px-4 py-2 ${
          msg.role === "user" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-100"
        }`}
      >
        <div className="text-xs text-gray-400 mb-1">
          {msg.role === "user" ? "You" : "Assistant"}
        </div>
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
});

function ToolCallCard({ event, count }: { event: ToolEvent; count: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`border rounded font-mono text-sm ${
        event.isError ? "border-red-700 bg-red-950/20" : "border-gray-700 bg-gray-900"
      }`}
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
      >
        <span className="text-gray-500">⚙</span>
        <span className={`font-semibold ${event.isError ? "text-red-400" : "text-gray-300"}`}>
          {event.toolName}
        </span>
        {count > 1 && (
          <span className="ml-2 text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded-full">
            +{count - 1} more
          </span>
        )}
        {event.isError && <span className="text-red-400 text-xs ml-2">error</span>}
        <span className="ml-auto text-gray-600 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-xs text-gray-400 space-y-1">
          {event.args && Object.keys(event.args).length > 0 && (
            <pre className="overflow-x-auto">{JSON.stringify(event.args, null, 2)}</pre>
          )}
          {event.result != null && (
            <>
              <div className="border-t border-gray-700 my-1" />
              <pre className="overflow-x-auto">
                {typeof event.result === "string"
                  ? event.result
                  : JSON.stringify(event.result, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const locationProject = (location.state as { project?: Project } | null)?.project;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [sending, setSending] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("none");
  const [streamingContent, setStreamingContent] = useState("");
  const [currentToolCall, setCurrentToolCall] = useState<ToolEvent | null>(null);
  const [toolCallCount, setToolCallCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoSentRef = useRef(false);
  const lastSeqIdRef = useRef(0);

  useEffect(() => {
    if (!id) return;

    // Reset all state when project changes — prevents stale data from previous project
    setMessages([]);
    setStreamingContent("");
    setThinkingMode("none");
    setCurrentToolCall(null);
    setToolCallCount(0);
    setIsLoadingMessages(true);
    lastSeqIdRef.current = 0;
    autoSentRef.current = false;

    wsClient.setProjectId(id);

    const unsubConnect = wsClient.onConnect(() => {
      wsClient.send({ type: "resume", lastSeqId: lastSeqIdRef.current });
    });

    wsClient.connect();

    loadMessages().then((msgs) => {
      if (!autoSentRef.current && msgs !== undefined && msgs.length === 0) {
        const desc = locationProject?.source?.freeformDescription?.trim();
        if (desc) {
          autoSentRef.current = true;
          setThinkingMode("processing");
          wsClient.send({ type: "prompt", text: desc });
          const userMessage: Message = {
            id: Date.now().toString(),
            projectId: id,
            role: "user",
            content: desc,
            timestamp: new Date().toISOString(),
          };
          setMessages([userMessage]);
        }
      }
    });

    const unsubMessage = wsClient.onMessage((data) => {
      if (!data || typeof data !== "object" || !("type" in data)) return;
      const msg = data as Record<string, unknown>;

      if (msg.type === "delta" && msg.text) {
        setThinkingMode("typing");
        setStreamingContent((prev) => prev + (msg.text as string));
      } else if (msg.type === "message_complete") {
        setStreamingContent("");
        setThinkingMode("processing");
        void loadMessages();
      } else if (msg.type === "conversation_complete") {
        setStreamingContent("");
        setThinkingMode("none");
        setCurrentToolCall(null);
        setToolCallCount(0);
        void loadMessages();
      } else if (msg.type === "replay" && Array.isArray(msg.messages)) {
        const replayedMessages = msg.messages as Message[];
        setMessages((prev) => {
          const existingSeqIds = new Set(prev.map((m) => m.seqId));
          const newFromReplay = replayedMessages.filter((m) => !existingSeqIds.has(m.seqId));
          if (newFromReplay.length === 0) return prev;
          return [...prev, ...newFromReplay].sort((a, b) => (a.seqId ?? 0) - (b.seqId ?? 0));
        });
        const maxSeq = replayedMessages.reduce((m, r) => Math.max(m, r.seqId ?? 0), 0);
        if (maxSeq > lastSeqIdRef.current) lastSeqIdRef.current = maxSeq;
      } else if (msg.type === "tool_call" && msg.agentType === "master") {
        setCurrentToolCall({
          toolName: msg.toolName as string,
          args: msg.args as Record<string, unknown> | undefined,
        });
        setToolCallCount((prev) => prev + 1);
      } else if (msg.type === "tool_result" && msg.agentType === "master") {
        setCurrentToolCall((prev) =>
          prev
            ? { ...prev, result: msg.result, isError: msg.isError as boolean | undefined }
            : null
        );
      }
    });

    return () => {
      unsubConnect();
      unsubMessage();
      wsClient.disconnect();
    };
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, streamingContent]);

  async function loadMessages(): Promise<Message[]> {
    if (!id) return [];
    try {
      const data = await api.projects.messages.list(id);
      // Replace state entirely — DB is source of truth, eliminates optimistic duplicates
      setMessages(data);
      const maxSeq = data.reduce((m, msg) => Math.max(m, msg.seqId ?? 0), 0);
      lastSeqIdRef.current = maxSeq;
      return data;
    } catch (err) {
      console.error("Failed to load messages:", err);
      return [];
    } finally {
      setIsLoadingMessages(false);
    }
  }

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!id || !input.trim() || sending) return;
      try {
        setSending(true);
        setThinkingMode("processing");
        wsClient.send({ type: "prompt", text: input.trim() });
        const userMessage: Message = {
          id: Date.now().toString(),
          projectId: id,
          role: "user",
          content: input.trim(),
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");
      } catch (err) {
        setThinkingMode("none");
        alert(err instanceof Error ? err.message : "Failed to send message");
      } finally {
        setSending(false);
      }
    },
    [id, input, sending]
  );

  const isThinking = thinkingMode === "processing";
  const isTyping = thinkingMode === "typing";

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Chat</h1>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 bg-gray-900 border border-gray-800 rounded-lg p-4">
        {messages.length === 0 && !streamingContent && !isThinking ? (
          <div className="text-gray-500 text-center py-8">
            No messages yet. Start the conversation!
          </div>
        ) : (
          <>
            {isLoadingMessages && messages.length > 0 && (
              <div className="text-gray-400">Loading...</div>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}

            {/* Current tool call — shown during active processing, replaced on each new call */}
            {thinkingMode !== "none" && currentToolCall && (
              <div className="flex justify-start">
                <div className="max-w-[80%]">
                  <ToolCallCard event={currentToolCall} count={toolCallCount} />
                </div>
              </div>
            )}

            {isTyping && streamingContent && (
              <div className="flex justify-start">
                <div
                  data-testid="assistant-streaming"
                  className="max-w-[80%] rounded-lg px-4 py-2 bg-gray-800 text-gray-100"
                >
                  <div className="text-xs text-gray-400 mb-1">Assistant</div>
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )}

            {isThinking && (
              <div className="flex justify-start">
                <div className="bg-gray-800 rounded-lg px-4 py-2 text-gray-400 text-sm flex items-center gap-2">
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
        >
          Send
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 8: Run all Chat tests, verify they pass**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Chat
```

Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
cd /home/ae/multi-agent-harness
git add frontend/src/pages/Chat.tsx frontend/src/pages/Chat.test.tsx
git commit -m "fix(frontend): chat state reset, dedup fix, React.memo perf, tool call display"
```

---

## Task 2: Planning Agent Lifecycle + Docker Cleanup — Bugs 3, 7

**Files:**
- Modify: `backend/src/orchestrator/planningAgentManager.ts`
- Modify: `backend/src/__tests__/planningAgentManager.test.ts`

**Context before starting:** Read both files in full. Tests use `vi.resetModules()` + dynamic `await import(...)` in each test. `makeMockDocker()` returns `{ docker, mockContainer }`. The mock `mockContainer` currently has `start`, `stop`, `attach` — you will add `remove` to it. Fake timers (`vi.useFakeTimers()`) require `vi.useRealTimers()` cleanup.

**Run tests:** `cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager`

---

- [ ] **Step 1: Write failing tests — lifecycle grace period and docker cleanup**

Add these `describe` blocks to `backend/src/__tests__/planningAgentManager.test.ts`:

```typescript
describe("PlanningAgentManager - lifecycle grace period", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("does not stop container immediately when last WS connection drops", async () => {
    vi.useFakeTimers();
    try {
      const { docker, mockContainer } = makeMockDocker();
      const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
      const mgr = new PlanningAgentManager(docker as never);
      await mgr.ensureRunning("proj-grace", []);
      mgr.incrementConnections("proj-grace");
      mgr.decrementConnections("proj-grace"); // last connection drops

      // Not stopped yet — grace timer still running
      expect(mockContainer.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops container after 2-minute grace period elapses", async () => {
    vi.useFakeTimers();
    try {
      const { docker, mockContainer } = makeMockDocker();
      const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
      const mgr = new PlanningAgentManager(docker as never);
      await mgr.ensureRunning("proj-timer", []);
      mgr.incrementConnections("proj-timer");
      mgr.decrementConnections("proj-timer");

      // Advance past the 120 s grace period
      await vi.advanceTimersByTimeAsync(121_000);

      expect(mockContainer.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels stop timer when new connection arrives during grace period", async () => {
    vi.useFakeTimers();
    try {
      const { docker, mockContainer } = makeMockDocker();
      const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
      const mgr = new PlanningAgentManager(docker as never);
      await mgr.ensureRunning("proj-cancel", []);
      mgr.incrementConnections("proj-cancel");
      mgr.decrementConnections("proj-cancel"); // grace timer starts

      mgr.incrementConnections("proj-cancel"); // new connection — should cancel timer
      await vi.advanceTimersByTimeAsync(121_000);

      expect(mockContainer.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PlanningAgentManager - docker cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    netState.lastSocket = null;
  });

  it("removes container after stopping", async () => {
    const { docker, mockContainer } = makeMockDocker();
    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.ensureRunning("proj-remove", []);
    await mgr.stopContainer("proj-remove");

    expect(mockContainer.stop).toHaveBeenCalled();
    expect(mockContainer.remove).toHaveBeenCalled();
  });

  it("cleanupStaleContainers removes stopped planning- and task- containers", async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    const { docker } = makeMockDocker();
    vi.mocked(docker.listContainers).mockResolvedValue([
      { Id: "aaa", Names: ["/planning-proj-1"], State: "exited" },
      { Id: "bbb", Names: ["/task-abc12345678"], State: "exited" },
      { Id: "ccc", Names: ["/planning-proj-2"], State: "running" }, // skip — running
      { Id: "ddd", Names: ["/other-container"], State: "exited" }, // skip — not ours
    ] as never);
    vi.mocked(docker.getContainer).mockReturnValue({ remove: removeMock } as never);

    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);
    await mgr.cleanupStaleContainers();

    // Only aaa and bbb removed
    expect(removeMock).toHaveBeenCalledTimes(2);
  });

  it("cleanupStaleContainers is non-fatal when removal fails", async () => {
    const { docker } = makeMockDocker();
    vi.mocked(docker.listContainers).mockResolvedValue([
      { Id: "aaa", Names: ["/planning-fail"], State: "exited" },
    ] as never);
    vi.mocked(docker.getContainer).mockReturnValue({
      remove: vi.fn().mockRejectedValue(new Error("no such container")),
    } as never);

    const { PlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const mgr = new PlanningAgentManager(docker as never);

    // Must not throw
    await expect(mgr.cleanupStaleContainers()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager
```

Expected: FAIL — `mockContainer.remove` undefined, lifecycle timer not implemented

---

- [ ] **Step 3: Add `remove` to `makeMockDocker` in the test file**

In `makeMockDocker`, add `remove: vi.fn().mockResolvedValue(undefined)` to `mockContainer`:

```typescript
const mockContainer = {
  id: "container-plan-123",
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),  // ADD THIS
  attach: vi.fn().mockImplementation((_opts: unknown, cb: (err: null, stream: EventEmitter) => void) => {
    const stream = new EventEmitter();
    cb(null, stream);
  }),
};
```

- [ ] **Step 4: Run tests again — expect only lifecycle failures now (remove test passes)**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager
```

Expected: `remove` tests now PASS; lifecycle/cleanup tests still FAIL

---

- [ ] **Step 5: Update `ProjectState` interface in `planningAgentManager.ts`**

Add two fields to `interface ProjectState`:

```typescript
lifecycleState: "starting" | "running" | "idle" | "stopping" | "crashed";
stopTimer: ReturnType<typeof setTimeout> | null;
```

- [ ] **Step 6: Initialise new fields in `ensureRunning`**

In the `state` object literal created after `connectTcp` succeeds, add:

```typescript
lifecycleState: "running",
stopTimer: null,
```

- [ ] **Step 7: Replace `checkStop` with grace-period version**

```typescript
private checkStop(projectId: string, state: ProjectState): void {
  if (state.wsConnectionCount > 0 || state.isStreaming || state.promptPending) return;
  if (state.lifecycleState !== "running") return;
  if (state.stopTimer) return; // already counting down

  state.lifecycleState = "idle";
  state.stopTimer = setTimeout(() => {
    state.stopTimer = null;
    console.log(`[PlanningAgentManager] grace period expired for ${projectId}, stopping`);
    void this.stopContainer(projectId);
  }, 120_000);
  console.log(`[PlanningAgentManager] ${projectId} → idle (2-min grace timer started)`);
}
```

- [ ] **Step 8: Update `incrementConnections` to cancel stop timer**

```typescript
incrementConnections(projectId: string): void {
  const state = this.projects.get(projectId);
  if (!state) return;
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
    state.lifecycleState = "running";
    console.log(`[PlanningAgentManager] ${projectId} → running (stop timer cancelled by new connection)`);
  }
  state.wsConnectionCount++;
}
```

- [ ] **Step 9: Update `sendPrompt` to cancel stop timer**

After the existing restart-if-missing block, before `state.promptPending = true`, add:

```typescript
// Cancel any pending stop timer — a prompt means the agent is actively needed
if (state.stopTimer) {
  clearTimeout(state.stopTimer);
  state.stopTimer = null;
  state.lifecycleState = "running";
  console.log(`[PlanningAgentManager] ${projectId} → running (stop timer cancelled by sendPrompt)`);
}
```

- [ ] **Step 10: Update `stopContainer` to set `lifecycleState` and remove container**

Replace the existing `stopContainer` body:

```typescript
async stopContainer(projectId: string): Promise<void> {
  const state = this.projects.get(projectId);
  if (!state) return;
  state.lifecycleState = "stopping";
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }
  this.projects.delete(projectId);
  state.tcpSocket.destroy();
  await this.commitSessionLog(projectId);
  try {
    await this.docker.getContainer(state.containerId).stop({ t: 10 });
    console.log(`[PlanningAgentManager] stopped container ${state.containerId}`);
    try {
      await this.docker.getContainer(state.containerId).remove();
      console.log(`[PlanningAgentManager] removed container ${state.containerId}`);
    } catch (removeErr) {
      console.warn(`[PlanningAgentManager] remove failed (non-fatal):`, removeErr);
    }
  } catch (err) {
    console.warn(`[PlanningAgentManager] stop failed (may already be stopped):`, err);
  }
}
```

- [ ] **Step 11: Update `listenTcp` close handler for crash detection**

Replace the existing `state.tcpSocket.on("close", ...)` handler:

```typescript
state.tcpSocket.on("close", () => {
  const currentState = this.projects.get(projectId);
  if (currentState && currentState.lifecycleState !== "stopping") {
    console.error(`[PlanningAgentManager] TCP socket closed unexpectedly for ${projectId} — marking as crashed`);
    if (currentState.stopTimer) {
      clearTimeout(currentState.stopTimer);
      currentState.stopTimer = null;
    }
    currentState.lifecycleState = "crashed";
    this.projects.delete(projectId);
    // Unblock any WS clients waiting for a response
    this.emit(currentState, { type: "conversation_complete" });
  } else {
    console.log(`[PlanningAgentManager] TCP RPC socket closed for ${projectId}`);
  }
});
```

- [ ] **Step 12: Add `cleanupStaleContainers` method**

Add this public method to `PlanningAgentManager`:

```typescript
async cleanupStaleContainers(): Promise<void> {
  try {
    const containers = await this.docker.listContainers({ all: true });
    const stale = containers.filter((c) => {
      const name = (c.Names?.[0] ?? "").replace(/^\//, "");
      return (name.startsWith("planning-") || name.startsWith("task-")) && c.State !== "running";
    });
    for (const c of stale) {
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
        console.log(`[PlanningAgentManager] cleaned up stale container ${c.Names?.[0]}`);
      } catch (err) {
        console.warn(`[PlanningAgentManager] cleanup failed for ${c.Id}:`, err);
      }
    }
    if (stale.length > 0) {
      console.log(`[PlanningAgentManager] cleaned up ${stale.length} stale container(s)`);
    }
  } catch (err) {
    console.warn(`[PlanningAgentManager] container cleanup error:`, err);
  }
}
```

- [ ] **Step 13: Call `cleanupStaleContainers` from `backend/src/index.ts`**

Find the line `setPlanningAgentManager(planningAgentManager)` (or equivalent) in `backend/src/index.ts` and add immediately after:

```typescript
void planningAgentManager.cleanupStaleContainers();
```

- [ ] **Step 14: Run all tests, verify they pass**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- planningAgentManager
```

Expected: ALL PASS

- [ ] **Step 15: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/orchestrator/planningAgentManager.ts \
        backend/src/index.ts \
        backend/src/__tests__/planningAgentManager.test.ts
git commit -m "fix(backend): planning agent lifecycle state machine + docker container cleanup"
```

---

## Task 3: Execution Tab AgentPicker — Bug 4

**Files:**
- Modify: `frontend/src/pages/Execution.tsx`
- Create: `frontend/src/pages/Execution.test.tsx`

**Context before starting:** Read `frontend/src/pages/Execution.tsx` in full. The `STATUS_DOT` map and `AgentInfo` type are defined at the top — `AgentPicker` will use them. Add `AgentPicker` just above the existing `ActivityCard` function. Replace the `flex-wrap` pill container in the `Execution` component JSX.

**Run tests:** `cd /home/ae/multi-agent-harness/frontend && npm test -- --run Execution`

---

- [ ] **Step 1: Create failing test file**

Create `frontend/src/pages/Execution.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Execution from './Execution';

vi.mock('../lib/api', () => ({
  api: {
    projects: {
      agents: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../lib/ws', () => ({
  wsClient: {
    setProjectId: vi.fn(),
    connect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  },
}));

global.fetch = vi.fn().mockResolvedValue({
  ok: false,
  json: async () => [],
} as Response);

function renderExecution() {
  return render(
    <MemoryRouter initialEntries={['/project/test-id/execute']}>
      <Routes>
        <Route path="/project/:id/execute" element={<Execution />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AgentPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a trigger button showing the selected agent label', async () => {
    renderExecution();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Planning Agent/i })).toBeInTheDocument();
    });
  });

  it('opens dropdown when trigger is clicked', async () => {
    renderExecution();
    const trigger = await screen.findByRole('button', { name: /Planning Agent/i });
    fireEvent.click(trigger);
    // The dropdown list shows the agent label as a list item button
    const allPlanningButtons = screen.getAllByText('Planning Agent');
    expect(allPlanningButtons.length).toBeGreaterThanOrEqual(2); // trigger + list item
  });

  it('closes dropdown when clicking outside', async () => {
    renderExecution();
    const trigger = await screen.findByRole('button', { name: /Planning Agent/i });
    fireEvent.click(trigger); // open
    const countOpen = screen.getAllByText('Planning Agent').length;
    expect(countOpen).toBeGreaterThanOrEqual(2);

    fireEvent.mouseDown(document.body); // outside click
    await waitFor(() => {
      // Back to just the trigger button
      expect(screen.getAllByText('Planning Agent')).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Execution
```

Expected: FAIL — AgentPicker dropdown not implemented

---

- [ ] **Step 3: Add `AgentPicker` component to `Execution.tsx`**

Add this function just above the existing `ActivityCard` function in `frontend/src/pages/Execution.tsx`:

```typescript
function AgentPicker({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentInfo[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const selectedAgent = agents.find((a) => a.id === selected);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-900 text-sm text-white hover:border-gray-500 min-w-[200px]"
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            STATUS_DOT[selectedAgent?.status ?? "idle"] ?? "bg-gray-600"
          }`}
        />
        <span className="flex-1 truncate text-left">
          {selectedAgent?.label ?? "Select agent"}
        </span>
        <span className="text-gray-500 ml-1 flex-shrink-0">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-10 bg-gray-900 border border-gray-700 rounded-lg shadow-lg min-w-[240px] max-h-64 overflow-y-auto">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                onSelect(agent.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-800 ${
                agent.id === selected ? "bg-gray-800 text-white" : "text-gray-300"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  STATUS_DOT[agent.status] ?? "bg-gray-600"
                }`}
              />
              <span className="truncate">{agent.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace pill container with `<AgentPicker />` in `Execution` JSX**

Find and replace the `{/* Agent selector pills */}` section:

**Remove:**
```tsx
{/* Agent selector pills */}
<div className="flex flex-wrap gap-2">
  {agents.map((agent) => (
    <button
      key={agent.id}
      onClick={() => setSelectedAgent(agent.id)}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors ${
        selectedAgent === agent.id
          ? "border-blue-500 bg-blue-900/30 text-white"
          : "border-gray-700 bg-gray-900 text-gray-400 hover:text-white"
      }`}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[agent.status] ?? "bg-gray-600"}`} />
      {agent.label}
    </button>
  ))}
</div>
```

**Add:**
```tsx
{/* Agent picker */}
<AgentPicker agents={agents} selected={selectedAgent} onSelect={setSelectedAgent} />
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Execution
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
cd /home/ae/multi-agent-harness
git add frontend/src/pages/Execution.tsx frontend/src/pages/Execution.test.tsx
git commit -m "feat(frontend): replace execution pills with AgentPicker dropdown (Bug 4)"
```

---

## Task 4: Backend Retry Infrastructure — Bug 6 (Backend)

**Files:**
- Modify: `backend/src/models/types.ts`
- Modify: `backend/src/store/db.ts`
- Modify: `backend/src/store/projects.ts`
- Modify: `backend/src/api/projects.ts`
- Modify: `backend/src/__tests__/projects.test.ts`

**Context before starting:** Read all five files in full. The `updateProject` function in `store/projects.ts` does a full merge-and-overwrite using `INSERT OR REPLACE` style. The migration helper `addColumnIfMissing` in `db.ts` is the correct pattern for adding new columns.

**Run tests:** `cd /home/ae/multi-agent-harness/backend && npm test -- projects`

---

- [ ] **Step 1: Write failing tests for the retry endpoint**

Read `backend/src/__tests__/projects.test.ts` to understand the test setup (how `app` and test DB are initialised, how `createTestProject` works). Then add:

```typescript
describe("POST /api/projects/:id/retry", () => {
  it("returns 404 for unknown project", async () => {
    const res = await request(app).post("/api/projects/nonexistent/retry");
    expect(res.status).toBe(404);
  });

  it("returns 400 when project is not in failed state", async () => {
    const project = createTestProject({ status: "executing" });
    const res = await request(app).post(`/api/projects/${project.id}/retry`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in a failed/i);
  });

  it("returns 200 and dispatched count for a failed project", async () => {
    const project = createTestProject({
      status: "failed",
      plan: {
        id: "plan-1",
        projectId: "proj-1",
        tasks: [
          { id: "t1", repositoryId: "repo-1", description: "Task 1", status: "failed" },
          { id: "t2", repositoryId: "repo-1", description: "Task 2", status: "completed" },
        ],
      },
    });
    const res = await request(app).post(`/api/projects/${project.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("dispatched");
  });

  it("clears lastError on retry", async () => {
    const project = createTestProject({ status: "failed", lastError: "disk full" });
    await request(app).post(`/api/projects/${project.id}/retry`);
    const updated = await request(app).get(`/api/projects/${project.id}`);
    expect(updated.body.lastError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- projects
```

Expected: FAIL — retry endpoint doesn't exist

---

- [ ] **Step 3: Add `lastError` to `Project` in `backend/src/models/types.ts`**

Find the `Project` interface and add:

```typescript
lastError?: string;
```

- [ ] **Step 4: Add `last_error` column migration in `backend/src/store/db.ts`**

Find the block of `addColumnIfMissing` calls at the end of `migrate()` and add:

```typescript
addColumnIfMissing("projects", "last_error", "TEXT");
```

- [ ] **Step 5: Update `backend/src/store/projects.ts` to handle `lastError`**

**5a. Add `last_error` to `ProjectRow` interface:**

```typescript
last_error: string | null;
```

**5b. Add `lastError` to `fromRow`:**

```typescript
lastError: row.last_error ?? undefined,
```

**5c. Add `last_error` to the `UPDATE` statement in `updateProject`:**

In the `SET` clause of the SQL, add `last_error=@lastError,` and in the `.run({...})` params add:

```typescript
lastError: merged.lastError ?? null,
```

- [ ] **Step 6: Add `POST /:id/retry` endpoint in `backend/src/api/projects.ts`**

Add before the `return router` line:

```typescript
// Retry a failed/errored project — resets failed tasks and restarts the planning agent
router.post("/:id/retry", async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.status !== "failed" && project.status !== "error") {
    res.status(400).json({ error: "Project is not in a failed or error state" });
    return;
  }

  updateProject(req.params.id, { lastError: undefined, status: "executing" });

  let dispatched = 0;
  try {
    const result = await getRecoveryService().dispatchFailedTasks(req.params.id);
    dispatched = result.count;
  } catch (err) {
    console.error(`[projects] retry: dispatchFailedTasks error:`, err);
  }

  let agentRestarted = false;
  try {
    const { getPlanningAgentManager } = await import("../orchestrator/planningAgentManager.js");
    const manager = getPlanningAgentManager();
    if (!manager.isRunning(req.params.id)) {
      const { listRepositories } = await import("../store/repositories.js");
      const allRepos = listRepositories().filter((r) => project.repositoryIds.includes(r.id));
      const ghToken = process.env.GITHUB_TOKEN;
      const repoUrls = allRepos.map((r) => ({
        id: r.id,
        name: r.name,
        url:
          ghToken && r.cloneUrl.startsWith("https://github.com/")
            ? r.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
            : r.cloneUrl,
      }));
      await manager.ensureRunning(req.params.id, repoUrls);
      agentRestarted = true;
    }
  } catch (err) {
    console.warn(`[projects] retry: failed to restart planning agent:`, err);
  }

  res.json({ dispatched, agentRestarted });
});
```

- [ ] **Step 7: Run tests, verify they pass**

```bash
cd /home/ae/multi-agent-harness/backend && npm test -- projects
```

Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
cd /home/ae/multi-agent-harness
git add backend/src/models/types.ts \
        backend/src/store/db.ts \
        backend/src/store/projects.ts \
        backend/src/api/projects.ts \
        backend/src/__tests__/projects.test.ts
git commit -m "feat(backend): project retry endpoint, lastError persistence, DB migration"
```

---

## Task 5: Frontend Retry UI + WS Resilience — Bug 6 (Frontend + WS)

> **⚠️ Run ONLY after Tasks 1 and 4 are both complete.**
> - Task 1 must finish first because this task modifies `Chat.tsx`
> - Task 4 must finish first because this task uses `api.projects.retry()`

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/Dashboard.tsx`
- Create: `frontend/src/pages/Dashboard.test.tsx`
- Modify: `frontend/src/pages/Chat.tsx` (add retry banner)
- Modify: `backend/src/api/websocket.ts`

**Run tests:**
- `cd /home/ae/multi-agent-harness/frontend && npm test -- --run Dashboard`
- `cd /home/ae/multi-agent-harness/backend && npm test`

---

- [ ] **Step 1: Add `projects.retry()` to `frontend/src/lib/api.ts`**

In the `projects` object inside `api`, add after `agents`:

```typescript
retry: (id: string) =>
  fetchJson<{ dispatched: number; agentRestarted: boolean }>(
    `${API_BASE}/projects/${id}/retry`,
    { method: "POST" }
  ),
```

- [ ] **Step 2: Write failing Dashboard tests**

Create `frontend/src/pages/Dashboard.test.tsx`:

```typescript
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
```

- [ ] **Step 3: Run tests, verify they fail**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Dashboard
```

Expected: FAIL — Retry button not in Dashboard yet

---

- [ ] **Step 4: Update `frontend/src/pages/Dashboard.tsx`**

**4a. Add `retrying` state and `handleRetry` after existing state declarations:**

```typescript
const [retrying, setRetrying] = useState<Set<string>>(new Set());

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
```

**4b. Add `lastError` display** — after `<p className="text-gray-500 text-xs">Created...</p>`, add:

```tsx
{project.lastError && (
  <p className="text-red-400 text-xs mt-1">{project.lastError}</p>
)}
```

**4c. Add Retry button** in the button group alongside Chat/Execute/Delete:

```tsx
{(project.status === "failed" || project.status === "error") && (
  <button
    onClick={() => handleRetry(project.id)}
    disabled={retrying.has(project.id)}
    className="text-green-400 hover:text-green-300 disabled:text-gray-600 disabled:cursor-not-allowed px-3 py-1 text-sm"
  >
    {retrying.has(project.id) ? "Retrying…" : "Retry"}
  </button>
)}
```

- [ ] **Step 5: Run Dashboard tests, verify they pass**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Dashboard
```

Expected: ALL PASS

---

- [ ] **Step 6: Add retry banner to `frontend/src/pages/Chat.tsx`**

Open `Chat.tsx` (already updated by Task 1).

**6a. Add `retryBanner` state** after the existing state declarations:

```typescript
const [retryBanner, setRetryBanner] = useState<{
  message: string;
  attempt?: number;
  maxAttempts?: number;
} | null>(null);
```

**6b. Reset banner in the project-change block** (add to the reset block at top of `useEffect([id])`):

```typescript
setRetryBanner(null);
```

**6c. Handle `error` type in the WS message handler** (add as a new `else if` branch):

```typescript
} else if (msg.type === "error") {
  const errMsg = msg as { message?: string; retrying?: boolean; attempt?: number; maxAttempts?: number };
  setRetryBanner({
    message: (errMsg.message as string) ?? "Unknown error",
    attempt: errMsg.retrying ? (errMsg.attempt as number | undefined) : undefined,
    maxAttempts: errMsg.retrying ? (errMsg.maxAttempts as number | undefined) : undefined,
  });
```

**6d. Dismiss banner on first successful delta** — in the `delta` handler add:

```typescript
setRetryBanner(null);
```

**6e. Render the banner** — add between the `<h1>` and the message feed `<div>`:

```tsx
{retryBanner && (
  <div
    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm ${
      retryBanner.attempt !== undefined
        ? "bg-amber-900/30 border border-amber-600 text-amber-400"
        : "bg-red-900/30 border border-red-600 text-red-400"
    }`}
  >
    <span>
      {retryBanner.attempt !== undefined
        ? `Starting agent… (attempt ${retryBanner.attempt}/${retryBanner.maxAttempts ?? 5})`
        : `Error: ${retryBanner.message}`}
    </span>
    <button
      onClick={() => setRetryBanner(null)}
      className="ml-auto text-xs opacity-70 hover:opacity-100"
    >
      ✕
    </button>
  </div>
)}
```

---

- [ ] **Step 7: Add WS retry helper to `backend/src/api/websocket.ts`**

Add this function before the `setupWebSocket` export:

```typescript
const WS_RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

async function ensureRunningWithRetry(
  manager: ReturnType<typeof getPlanningAgentManager>,
  projectId: string,
  repoUrls: Array<{ id?: string; name: string; url: string }>,
  ws: WebSocket
): Promise<boolean> {
  for (let attempt = 0; attempt <= WS_RETRY_DELAYS.length; attempt++) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      await manager.ensureRunning(projectId, repoUrls);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[ws] ensureRunning failed for ${projectId} (attempt ${attempt + 1}):`, msg);
      if (attempt < WS_RETRY_DELAYS.length) {
        send(ws, {
          type: "error",
          message: msg,
          retrying: true,
          attempt: attempt + 1,
          maxAttempts: WS_RETRY_DELAYS.length + 1,
        });
        // Wait for retry delay, but abort early if the client disconnects
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, WS_RETRY_DELAYS[attempt]);
          ws.once("close", () => { clearTimeout(timer); resolve(); });
        });
        if (ws.readyState !== WebSocket.OPEN) return false;
      } else {
        // All retries exhausted — persist the error and close
        try {
          updateProject(projectId, { lastError: msg });
        } catch { /* ignore */ }
        send(ws, {
          type: "error",
          message: `Failed to start agent after ${WS_RETRY_DELAYS.length + 1} attempts: ${msg}`,
        });
        ws.close(1011, "Failed to start planning agent");
        return false;
      }
    }
  }
  return false;
}
```

- [ ] **Step 8: Replace `ensureRunning` try/catch in `setupWebSocket`**

Find:
```typescript
try {
  await manager.ensureRunning(projectId, repoUrls);
} catch (err) {
  console.error(`[ws] failed to start planning agent for ${projectId}:`, err);
  send(ws, { type: "error", message: "Failed to start planning agent" });
  ws.close(1011, "Failed to start planning agent");
  return;
}
```

Replace with:
```typescript
const started = await ensureRunningWithRetry(manager, projectId, repoUrls, ws);
if (!started) return;
```

- [ ] **Step 9: Run all tests**

```bash
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Dashboard
cd /home/ae/multi-agent-harness/frontend && npm test -- --run Chat
cd /home/ae/multi-agent-harness/backend && npm test
```

Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
cd /home/ae/multi-agent-harness
git add frontend/src/pages/Chat.tsx \
        frontend/src/pages/Dashboard.tsx \
        frontend/src/pages/Dashboard.test.tsx \
        frontend/src/lib/api.ts \
        backend/src/api/websocket.ts
git commit -m "feat: project recovery — WS retry loop, retry banner, dashboard retry button"
```

---

## Final Verification

After all tasks complete, run the full test suite:

```bash
cd /home/ae/multi-agent-harness
npm test
npm run --cwd frontend test
```

Expected: All backend and frontend tests pass with no regressions.
