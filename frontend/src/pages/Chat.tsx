import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, Message, Project } from "../lib/api";
import { wsClient } from "../lib/ws";

type ThinkingMode = "none" | "typing" | "processing";

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoSentRef = useRef(false);
  const lastSeqIdRef = useRef(0);

  useEffect(() => {
    if (!id) return;
    wsClient.setProjectId(id);

    // On (re)connect: send resume to replay any messages missed while disconnected
    const unsubConnect = wsClient.onConnect(() => {
      wsClient.send({ type: "resume", lastSeqId: lastSeqIdRef.current });
    });

    wsClient.connect();

    loadMessages().then((msgs) => {
      // Auto-send freeform description as first message for new projects
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
      const msg = data as { type: string; text?: string; messages?: Message[] };

      if (msg.type === "delta" && msg.text) {
        setThinkingMode("typing");
        setStreamingContent((prev) => prev + msg.text);
      } else if (msg.type === "message_complete") {
        // A single agent turn finished — reload persisted messages, clear streaming
        setStreamingContent("");
        setThinkingMode("processing");
        loadMessages();
      } else if (msg.type === "conversation_complete") {
        // The full prompt/response cycle is done
        setStreamingContent("");
        setThinkingMode("none");
        loadMessages();
      } else if (msg.type === "replay" && Array.isArray(msg.messages)) {
        // Merge replay messages with existing, deduplicate by seqId
        const replayedMessages = msg.messages as Message[];
        setMessages((prev) => {
          const existingSeqIds = new Set(prev.map((m) => m.seqId));
          const newFromReplay = replayedMessages.filter((m) => !existingSeqIds.has(m.seqId));

          if (newFromReplay.length === 0) return prev;

          const merged = [...prev, ...newFromReplay].sort((a, b) => (a.seqId ?? 0) - (b.seqId ?? 0));
          return merged;
        });

        const maxSeq = replayedMessages.reduce((m, msg) => Math.max(m, msg.seqId ?? 0), 0);
        if (maxSeq > lastSeqIdRef.current) lastSeqIdRef.current = maxSeq;
      }
    });

    return () => {
      unsubConnect();
      unsubMessage();
    };
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, streamingContent]);

  async function loadMessages(): Promise<Message[]> {
    if (!id) return [];
    try {
      const data = await api.projects.messages.list(id);
      // Merge with existing messages, deduplicate by seqId
      // This prevents flickering/clearing of messages when reloading
      setMessages((prev) => {
        const existingSeqIds = new Set(prev.map((m) => m.seqId));
        const newMsgs = data.filter((m) => !existingSeqIds.has(m.seqId));

        if (newMsgs.length === 0) return prev; // No new messages

        const merged = [...prev, ...newMsgs].sort((a, b) => (a.seqId ?? 0) - (b.seqId ?? 0));
        return merged;
      });

      const maxSeq = data.reduce((m, msg) => Math.max(m, msg.seqId ?? 0), 0);
      if (maxSeq > lastSeqIdRef.current) lastSeqIdRef.current = maxSeq;

      return data;
    } catch (err) {
      console.error("Failed to load messages:", err);
      return [];
    } finally {
      setIsLoadingMessages(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
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
  }

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
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  data-testid={msg.role === "assistant" ? "assistant-message" : undefined}
                  className={`max-w-[80%] rounded-lg px-4 py-2 ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-100"
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
            ))}

            {/* Streaming text (rendered as markdown) */}
            {isTyping && streamingContent && (
              <div className="flex justify-start">
                <div data-testid="assistant-streaming" className="max-w-[80%] rounded-lg px-4 py-2 bg-gray-800 text-gray-100">
                  <div className="text-xs text-gray-400 mb-1">Assistant</div>
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )}

            {/* Thinking/processing indicator */}
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
