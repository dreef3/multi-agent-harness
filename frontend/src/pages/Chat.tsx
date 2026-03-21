import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { api, Message } from "../lib/api";
import { wsClient } from "../lib/ws";

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    wsClient.setProjectId(id);
    loadMessages();
    wsClient.connect();

    const unsubscribe = wsClient.onMessage((data) => {
      if (data && typeof data === "object" && "type" in data) {
        const msg = data as { type: string; text?: string; payload?: Message };
        if (msg.type === "delta" && msg.text) {
          setStreamingContent((prev) => prev + msg.text);
        } else if (msg.type === "message_complete") {
          loadMessages().then(async () => {
            setStreamingContent("");
            try {
              const project = await api.projects.get(id!);
              if (project.status === "awaiting_approval") {
                navigate(`/projects/${id}/plan`);
              }
            } catch { /* ignore */ }
          });
        } else if (msg.type === "plan_ready") {
          navigate(`/projects/${id}/plan`);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [id, navigate]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadMessages() {
    if (!id) return;
    try {
      const data = await api.projects.messages.list(id);
      setMessages(data);
    } catch (err) {
      console.error("Failed to load messages:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !input.trim() || sending) return;

    try {
      setSending(true);
      // Send message via WebSocket
      wsClient.send({ type: "prompt", text: input.trim() });
      // Optimistically add user message to UI
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
      alert(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  if (loading) return <div className="text-gray-400">Loading...</div>;

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Chat</h1>
        <button
          onClick={() => navigate(`/projects/${id}/plan`)}
          className="text-green-400 hover:text-green-300 text-sm"
        >
          View Plan →
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 bg-gray-900 border border-gray-800 rounded-lg p-4">
        {messages.length === 0 && !streamingContent ? (
          <div className="text-gray-500 text-center py-8">
            No messages yet. Start the conversation!
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
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
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            ))}
            {streamingContent && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-lg px-4 py-2 bg-gray-800 text-gray-100">
                  <div className="text-xs text-gray-400 mb-1">Assistant</div>
                  <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap">
                    {streamingContent}
                  </div>
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
          disabled={sending}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}
