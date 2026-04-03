import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, Message, Project } from "../lib/api";
import { wsClient } from "../lib/ws";
import { type WsAcpEvent, isAcpEvent } from "../lib/acpEvents.js";

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
  const [retryBanner, setRetryBanner] = useState<{
    message: string;
    attempt?: number;
    maxAttempts?: number;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoSentRef = useRef(false);
  const lastSeqIdRef = useRef(0);

  useEffect(() => {
    if (!id) return;

    // Reset all state when project changes — prevents stale data from previous project
    setMessages([]);
    setInput("");
    setSending(false);
    setStreamingContent("");
    setThinkingMode("none");
    setCurrentToolCall(null);
    setToolCallCount(0);
    setRetryBanner(null);
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
        setRetryBanner(null);
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
      } else if (msg.type === "error") {
        const errMsg = msg as { message?: string; retrying?: boolean; attempt?: number; maxAttempts?: number };
        setRetryBanner({
          message: (errMsg.message as string) ?? "Unknown error",
          attempt: errMsg.retrying ? (errMsg.attempt as number | undefined) : undefined,
          maxAttempts: errMsg.retrying ? (errMsg.maxAttempts as number | undefined) : undefined,
        });
      } else if (isAcpEvent(msg as { type: string })) {
        const acpMsg = msg as unknown as WsAcpEvent;
        if (acpMsg.type === "acp:agent_message_chunk") {
          if (acpMsg.content?.type === "text" && acpMsg.content.text) {
            setThinkingMode("typing");
            setStreamingContent((prev) => prev + acpMsg.content.text!);
            setRetryBanner(null);
          }
        } else if (acpMsg.type === "acp:tool_call") {
          setCurrentToolCall({
            toolName: acpMsg.title,
            args: { kind: acpMsg.kind, status: acpMsg.status },
          });
          setToolCallCount((prev) => prev + 1);
        } else if (acpMsg.type === "acp:tool_call_update") {
          setCurrentToolCall((prev) =>
            prev ? { ...prev, result: acpMsg.status } : null
          );
        } else if (acpMsg.type === "acp:plan") {
          // Show plan as a tool card summarising the items
          const planSummary = acpMsg.items.map((item) => `${item.status}: ${item.title}`).join("\n");
          setCurrentToolCall({
            toolName: "Plan",
            args: {},
            result: planSummary,
          });
          setToolCallCount((prev) => prev + 1);
        } else if (acpMsg.type === "acp:turn_complete") {
          setStreamingContent("");
          setThinkingMode("processing");
          void loadMessages();
        } else if (acpMsg.type === "acp:error") {
          setRetryBanner({ message: acpMsg.message });
        } else if (acpMsg.type === "agent:started") {
          setThinkingMode("processing");
          setRetryBanner(null);
        } else if (acpMsg.type === "agent:stopped") {
          setThinkingMode("none");
          setCurrentToolCall(null);
          setToolCallCount(0);
          void loadMessages();
        } else if (acpMsg.type === "agent:crashed") {
          setThinkingMode("none");
          setRetryBanner({ message: `Agent crashed: ${acpMsg.message}` });
        }
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
        <div className="flex items-center gap-3">
          <Link to="/" aria-label="Back to projects" className="text-blue-400 hover:text-blue-300 focus:outline-none">
            <span aria-hidden="true">← </span>
            <span>Projects</span>
          </Link>
          <h1 className="text-2xl font-bold">Chat</h1>
        </div>
        {id && (
          <Link
            to={`/projects/${id}/agents`}
            className="text-sm text-gray-400 hover:text-gray-200"
          >
            Agent Settings
          </Link>
        )}
      </div>

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

      <div className="flex-1 overflow-y-auto space-y-3 bg-gray-900 border border-gray-800 rounded-lg py-4 px-0 sm:px-4">
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
