import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { api, type AgentConfig, type AvailableAgent } from "../lib/api";

export default function AgentSettings() {
  const { id: projectId } = useParams<{ id: string }>();
  const [available, setAvailable] = useState<AvailableAgent[]>([]);
  const [planning, setPlanning] = useState<AgentConfig>({ type: "" });
  const [implementation, setImplementation] = useState<AgentConfig>({ type: "" });
  const [defaults, setDefaults] = useState<{ planningAgent: AgentConfig; implementationAgent: AgentConfig } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api.agentConfig.available(),
      api.agentConfig.get(projectId),
    ]).then(([avail, config]) => {
      setAvailable(avail.agents);
      setDefaults(config.defaults);
      setPlanning(config.planningAgent ?? config.defaults.planningAgent);
      setImplementation(config.implementationAgent ?? config.defaults.implementationAgent);
    }).catch((err: unknown) => {
      setMessage(`Failed to load config: ${err instanceof Error ? err.message : "Unknown error"}`);
    });
  }, [projectId]);

  const handleSave = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      await api.agentConfig.update(projectId, {
        planningAgent: planning,
        implementationAgent: implementation,
      });
      setMessage("Saved");
    } catch (err: unknown) {
      setMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setSaving(false);
  };

  const handleReset = () => {
    if (!defaults) return;
    setPlanning(defaults.planningAgent);
    setImplementation(defaults.implementationAgent);
  };

  const enabledAgents = available.filter((a) => a.available);

  return (
    <div className="max-w-xl mx-auto p-6">
      <h2 className="text-xl font-bold mb-4">Agent Configuration</h2>

      <section className="mb-6">
        <h3 className="font-semibold mb-2">Planning Agent</h3>
        <div className="flex gap-4">
          <select
            value={planning.type}
            onChange={(e) => setPlanning({ ...planning, type: e.target.value })}
            disabled={enabledAgents.length === 0}
            className="border rounded px-2 py-1"
          >
            {enabledAgents.length === 0 && <option value="">No agents available</option>}
            {enabledAgents.map((a) => (
              <option key={a.type} value={a.type}>{a.type}</option>
            ))}
          </select>
          <input
            type="text"
            value={planning.model ?? ""}
            onChange={(e) => setPlanning({ ...planning, model: e.target.value || undefined })}
            placeholder="Model (optional)"
            className="border rounded px-2 py-1 flex-1"
          />
        </div>
      </section>

      <section className="mb-6">
        <h3 className="font-semibold mb-2">Implementation Agent</h3>
        <div className="flex gap-4">
          <select
            value={implementation.type}
            onChange={(e) => setImplementation({ ...implementation, type: e.target.value })}
            disabled={enabledAgents.length === 0}
            className="border rounded px-2 py-1"
          >
            {enabledAgents.length === 0 && <option value="">No agents available</option>}
            {enabledAgents.map((a) => (
              <option key={a.type} value={a.type}>{a.type}</option>
            ))}
          </select>
          <input
            type="text"
            value={implementation.model ?? ""}
            onChange={(e) => setImplementation({ ...implementation, model: e.target.value || undefined })}
            placeholder="Model (optional)"
            className="border rounded px-2 py-1 flex-1"
          />
        </div>
      </section>

      {defaults && (
        <p className="text-sm text-gray-500 mb-4">
          Defaults: {defaults.planningAgent.type}/{defaults.planningAgent.model} (planning),
          {" "}{defaults.implementationAgent.type}/{defaults.implementationAgent.model} (implementation)
        </p>
      )}

      <div className="flex gap-3">
        <button onClick={handleSave} disabled={saving || enabledAgents.length === 0} className="bg-blue-600 text-white px-4 py-2 rounded">
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={handleReset} className="border px-4 py-2 rounded">
          Reset to defaults
        </button>
      </div>

      {message && <p className="mt-3 text-sm">{message}</p>}
    </div>
  );
}
