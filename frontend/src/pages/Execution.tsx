import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { wsClient } from "../lib/ws";

interface ExecutionStatus {
  status: "idle" | "running" | "completed" | "failed";
  currentTask?: {
    id: string;
    description: string;
  };
  progress: number;
  logs: string[];
}

export default function Execution() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ExecutionStatus>({
    status: "idle",
    progress: 0,
    logs: [],
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    wsClient.setProjectId(id);
    wsClient.connect();

    const unsubscribe = wsClient.onMessage((data) => {
      if (data && typeof data === "object" && "type" in data) {
        const msg = data as {
          type: string;
          payload?: {
            status?: string;
            currentTask?: { id: string; description: string };
            progress?: number;
            log?: string;
          };
        };
        
        if (msg.type === "execution_status" && msg.payload) {
          setStatus((prev) => ({
            ...prev,
            status: (msg.payload!.status as ExecutionStatus["status"]) || prev.status,
            currentTask: msg.payload!.currentTask || prev.currentTask,
            progress: msg.payload!.progress ?? prev.progress,
            logs: msg.payload!.log
              ? [...prev.logs, msg.payload!.log]
              : prev.logs,
          }));
        } else if (msg.type === "execution_complete") {
          setStatus((prev) => ({ ...prev, status: "completed" }));
        } else if (msg.type === "execution_error") {
          setStatus((prev) => ({ ...prev, status: "failed" }));
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [id]);

  async function handleStart() {
    if (!id || loading) return;
    try {
      setLoading(true);
      // Execution start endpoint not implemented yet
      // await api.projects.approve(id);
      setStatus((prev) => ({ ...prev, status: "running" }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to start execution");
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    if (!id || loading) return;
    try {
      setLoading(true);
      // Execution stop endpoint not implemented yet
      // await api.projects.cancel(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to stop execution");
    } finally {
      setLoading(false);
    }
  }

  const statusColors: Record<string, string> = {
    idle: "bg-gray-600",
    running: "bg-blue-600",
    completed: "bg-green-600",
    failed: "bg-red-600",
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Execution</h1>
        <span
          className={`text-xs px-3 py-1 rounded-full ${
            statusColors[status.status] || "bg-gray-600"
          }`}
        >
          {status.status}
        </span>
      </div>

      {status.currentTask && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Current Task</h2>
          <p className="text-white">{status.currentTask.description}</p>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-400">Progress</span>
          <span className="text-sm text-white">{Math.round(status.progress)}%</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${status.progress}%` }}
          />
        </div>
      </div>

      <div className="bg-gray-950 border border-gray-800 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-400 mb-2">Logs</h2>
        <div className="h-64 overflow-y-auto font-mono text-sm space-y-1">
          {status.logs.length === 0 ? (
            <p className="text-gray-600">No logs yet...</p>
          ) : (
            status.logs.map((log, index) => (
              <div key={index} className="text-gray-300">
                <span className="text-gray-600">[{new Date().toLocaleTimeString()}]</span>{" "}
                {log}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {status.status === "idle" || status.status === "failed" ? (
          <button
            onClick={handleStart}
            disabled={loading}
            className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
          >
            {loading ? "Starting..." : "Start Execution"}
          </button>
        ) : status.status === "running" ? (
          <button
            onClick={handleStop}
            disabled={loading}
            className="bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
          >
            {loading ? "Stopping..." : "Stop Execution"}
          </button>
        ) : null}
        <button
          onClick={() => navigate(`/projects/${id}/plan`)}
          className="text-gray-400 hover:text-white"
        >
          ← Back to Plan
        </button>
      </div>
    </div>
  );
}
