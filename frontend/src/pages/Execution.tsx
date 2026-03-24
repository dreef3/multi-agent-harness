import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { wsClient } from "../lib/ws";
import { api } from "../lib/api";
import type { AgentSession } from "../lib/api";

interface ActivityEvent {
  id: string;
  agentId: "master" | string;
  type: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  text?: string;
  from?: string; // for message_in: "Planning Agent"
  timestamp: string;
}

interface AgentInfo {
  id: "master" | string;
  label: string;
  status: "running" | "completed" | "failed" | "stuck" | "idle";
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-blue-500 animate-pulse",
  completed: "bg-green-500",
  failed: "bg-red-500",
  stuck: "bg-amber-500",
  idle: "bg-gray-600",
};

export default function Execution() {
  const { id } = useParams<{ id: string }>();
  const [agents, setAgents] = useState<AgentInfo[]>([
    { id: "master", label: "Planning Agent", status: "idle" },
  ]);
  const [selectedAgent, setSelectedAgent] = useState<string>("master");
  const [events, setEvents] = useState<Map<string, ActivityEvent[]>>(new Map());
  const [atBottom, setAtBottom] = useState(true);
  const feedRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const addEvent = useCallback((agentId: string, evt: ActivityEvent) => {
    setEvents((prev) => {
      const m = new Map(prev);
      m.set(agentId, [...(m.get(agentId) ?? []), evt]);
      return m;
    });
    // Resume status after activity resumes for stuck agents
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId && a.status === "stuck") ? { ...a, status: "running" } : a)
    );
  }, []);

  // Load existing sub-agent sessions
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const { signal } = controller;

    api.projects.agents(id).then((sessions: AgentSession[]) => {
      if (signal.aborted) return;
      const subInfos: AgentInfo[] = sessions
        .filter((s) => s.type === "sub")
        .map((s) => ({
          id: s.id,
          label: (s.taskId ?? s.id).slice(0, 40),
          status: s.status as AgentInfo["status"],
        }));
      if (subInfos.length > 0) {
        setAgents((prev) => {
          const existing = new Set(prev.map((a) => a.id));
          return [...prev, ...subInfos.filter((a) => !existing.has(a.id))];
        });
        // Replay events for each existing sub-agent session
        subInfos.forEach((info) => {
          fetch(`/api/agents/${info.id}/events`, { signal })
            .then((r) => {
              if (!r.ok) {
                console.warn(`[Execution] Failed to fetch events for ${info.id}: HTTP ${r.status}`);
                return null;
              }
              return r.json() as Promise<Array<{ type: string; payload: Record<string, unknown>; timestamp: string }>>;
            })
            .then((evts) => {
              if (!evts || signal.aborted) return;
              const mapped: ActivityEvent[] = evts.map((e, i) => ({
                id: `${info.id}-replay-${i}`,
                agentId: info.id,
                type: e.type,
                toolName: e.payload.toolName as string | undefined,
                args: e.payload.args as Record<string, unknown> | undefined,
                result: e.payload.result,
                isError: e.payload.isError as boolean | undefined,
                text: (e.payload.text ?? e.payload.delta) as string | undefined,
                from: e.payload.from as string | undefined,
                timestamp: e.timestamp,
              }));
              setEvents((prev) => { const m = new Map(prev); m.set(info.id, mapped); return m; });
            })
            .catch((err: unknown) => {
              if (err instanceof DOMException && err.name === "AbortError") return;
              console.error(`[Execution] Error fetching events for ${info.id}:`, err);
            });
        });
      }
    }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[Execution] Error fetching agent sessions:", err);
    });

    return () => controller.abort();
  }, [id]);

  // Replay planning agent events on mount
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const { signal } = controller;

    fetch(`/api/projects/${id}/master-events`, { signal })
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<
          Array<{ type: string; payload: Record<string, unknown>; timestamp: string }>
        >;
      })
      .then((evts) => {
        if (!evts || signal.aborted || evts.length === 0) return;
        const mapped: ActivityEvent[] = evts.map((e, i) => ({
          id: `master-replay-${i}`,
          agentId: "master",
          type: e.type,
          toolName: e.payload.toolName as string | undefined,
          args: e.payload.args as Record<string, unknown> | undefined,
          result: e.payload.result,
          isError: e.payload.isError as boolean | undefined,
          text: (e.payload.text ?? e.payload.delta) as string | undefined,
          timestamp: e.timestamp,
        }));
        setEvents((prev) => {
          const m = new Map(prev);
          m.set("master", mapped);
          return m;
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[Execution] Error fetching master events:", err);
      });

    return () => controller.abort();
  }, [id]);

  // WebSocket handler
  useEffect(() => {
    if (!id) return;
    wsClient.setProjectId(id);
    wsClient.connect();

    const unsub = wsClient.onMessage((data) => {
      if (!data || typeof data !== "object" || !("type" in data)) return;
      const msg = data as Record<string, unknown>;

      // Master agent events (tool_call, tool_result, thinking from planning agent)
      if (
        (msg.type === "tool_call" || msg.type === "tool_result" || msg.type === "thinking") &&
        msg.agentType === "master"
      ) {
        const evt: ActivityEvent = {
          id: `master-${Date.now()}-${Math.random()}`,
          agentId: "master",
          type: msg.type as string,
          toolName: msg.toolName as string | undefined,
          args: msg.args as Record<string, unknown> | undefined,
          result: msg.result,
          isError: msg.isError as boolean | undefined,
          text: msg.text as string | undefined,
          timestamp: new Date().toISOString(),
        };
        addEvent("master", evt);
        setAgents((prev) => prev.map((a) => a.id === "master" ? { ...a, status: "running" } : a));
      }

      // Sub-agent activity events
      if (msg.type === "agent_activity" && msg.agentType === "sub") {
        const sessionId = msg.sessionId as string;
        const inner = msg.event as { type: string; payload: Record<string, unknown>; timestamp: string } | undefined;
        if (!inner || typeof inner !== "object") return;
        const evt: ActivityEvent = {
          id: `${sessionId}-${Date.now()}-${Math.random()}`,
          agentId: sessionId,
          type: inner.type,
          toolName: inner.payload?.toolName as string | undefined,
          args: inner.payload?.args as Record<string, unknown> | undefined,
          result: inner.payload?.result,
          isError: inner.payload?.isError as boolean | undefined,
          text: (inner.payload?.text ?? inner.payload?.delta) as string | undefined,
          from: inner.payload?.from as string | undefined,
          timestamp: inner.timestamp,
        };
        addEvent(sessionId, evt);

        // Ensure pill exists for this session
        setAgents((prev) => {
          if (prev.some((a) => a.id === sessionId)) return prev;
          return [...prev, { id: sessionId, label: sessionId.slice(0, 40), status: "running" }];
        });
        // Auto-select first sub-agent when it appears
        setSelectedAgent((cur) => cur === "master" ? sessionId : cur);
      }

      // Stuck agent notification
      if (msg.type === "stuck_agent") {
        const sessionId = msg.sessionId as string;
        setAgents((prev) => prev.map((a) => a.id === sessionId ? { ...a, status: "stuck" } : a));
      }

      // Session completion broadcasts
      // conversation_complete fires when the overall project conversation finishes.
      // Mark master as completed, and also mark any sub-agents still in running/stuck
      // state as completed (no separate per-sub-agent terminal WS event exists).
      if (msg.type === "conversation_complete") {
        setAgents((prev) => prev.map((a) =>
          (a.id === "master" || a.status === "running" || a.status === "stuck")
            ? { ...a, status: "completed" }
            : a
        ));
      }
    });

    return () => unsub();
  }, [id, addEvent]);

  // Auto-scroll
  useEffect(() => {
    if (atBottom && typeof bottomRef.current?.scrollIntoView === "function") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, atBottom, selectedAgent]);

  const handleScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const selectedAgent_ = agents.find((a) => a.id === selectedAgent);
  const selectedEvents = events.get(selectedAgent) ?? [];
  const isRunning = selectedAgent_?.status === "running";

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col gap-3">
      <h1 className="text-2xl font-bold">Execution</h1>

      {/* Agent picker */}
      <AgentPicker agents={agents} selected={selectedAgent} onSelect={setSelectedAgent} />

      {/* Stuck indicator banner */}
      {selectedAgent_?.status === "stuck" && (
        <div className="flex items-center gap-2 bg-amber-900/30 border border-amber-600 rounded-lg px-4 py-2 text-amber-400 text-sm">
          ⚠ No activity for 4 minutes
        </div>
      )}

      {/* Activity feed */}
      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-gray-950 border border-gray-800 rounded-lg p-4 space-y-2"
      >
        {selectedEvents.length === 0 ? (
          <p className="text-gray-600 text-center py-8 font-mono text-sm">No activity yet…</p>
        ) : (
          selectedEvents.map((evt) => <ActivityCard key={evt.id} event={evt} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom */}
      {!atBottom && isRunning && (
        <button
          onClick={() => { if (typeof bottomRef.current?.scrollIntoView === "function") bottomRef.current.scrollIntoView({ behavior: "smooth" }); setAtBottom(true); }}
          className="self-center bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-1.5 rounded-full"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}

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

function ActivityCard({ event }: { event: ActivityEvent }) {
  const [expanded, setExpanded] = useState(false);

  // Conversation cards (Q&A between sub-agent and planning agent)
  if (event.type === "message_out") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-900/30 border border-blue-700 rounded-lg px-3 py-2 text-sm">
          <div className="text-xs text-blue-400 mb-1">Sub-agent asks</div>
          <p className="text-gray-200">{event.text}</p>
        </div>
      </div>
    );
  }

  if (event.type === "message_in") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
          <div className="text-xs text-gray-400 mb-1">{event.from ?? "Planning Agent"}</div>
          <p className="text-gray-200">{event.text}</p>
        </div>
      </div>
    );
  }

  // Tool call / tool result cards
  if (event.type === "tool_call" || event.type === "tool_result") {
    return (
      <div className={`border rounded font-mono text-sm ${event.isError ? "border-red-700 bg-red-950/20" : "border-gray-800 bg-gray-900"}`}>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 w-full px-3 py-2 text-left"
        >
          <span className="text-gray-500">⚙</span>
          <span className={`font-semibold ${event.isError ? "text-red-400" : "text-gray-300"}`}>
            {event.toolName ?? "(unknown)"}
          </span>
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
                  {typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // Thinking bubble
  if (event.type === "thinking") {
    return (
      <div className="text-gray-500 text-xs italic px-2 font-mono">
        <span className="mr-1">💭</span>{event.text}
      </div>
    );
  }

  // Generic text
  return (
    <div className="text-gray-300 text-sm px-2 font-mono">
      {event.text ?? JSON.stringify(event)}
    </div>
  );
}
