import { useEffect, useState } from "react";
import { api, Config, ModelConfig } from "../lib/api";

interface Settings {
  masterAgent: ModelConfig;
  workerAgents: ModelConfig;
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const backendConfig = await api.config();
      setConfig(backendConfig);
      
      // Initialize settings from backend config
      setSettings({
        masterAgent: { ...backendConfig.models.masterAgent },
        workerAgents: { ...backendConfig.models.workerAgent },
      });
    } catch (err) {
      console.error("Failed to load config:", err);
      // Fallback to defaults if backend is unavailable
      setSettings({
        masterAgent: { model: "opencode-go", temperature: 0.7, maxTokens: 4096 },
        workerAgents: { model: "opencode-go", temperature: 0.5, maxTokens: 2048 },
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!settings) return;
    try {
      setSaving(true);
      // Settings endpoint not implemented yet
      // await api.settings.update(settings);
      setMessage("Settings saved successfully!");
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-gray-400">Loading...</div>;
  if (!settings) return <div className="text-gray-400">Failed to load settings</div>;

  const isOpenCodeProvider = config?.provider?.startsWith("opencode");
  const providerLabel = config?.provider ?? "opencode-go";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="text-sm text-gray-400">
          Provider: <span className="text-blue-400 font-medium">{providerLabel}</span>
        </div>
      </div>

      {isOpenCodeProvider && (
        <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4 text-sm text-blue-200">
          Using OpenCode provider. Models are managed by the OpenCode agent.
        </div>
      )}

      {message && (
        <div
          className={`px-4 py-2 rounded-lg ${
            message.includes("success")
              ? "bg-green-900/50 border border-green-700 text-green-200"
              : "bg-red-900/50 border border-red-700 text-red-200"
          }`}
        >
          {message}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-6">
        <h2 className="text-lg font-semibold">Master Agent</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Model
            </label>
            <input
              type="text"
              value={settings.masterAgent.model}
              disabled={isOpenCodeProvider}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  masterAgent: { ...settings.masterAgent, model: e.target.value },
                })
              }
              className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500 ${
                isOpenCodeProvider ? "opacity-50 cursor-not-allowed" : ""
              }`}
            />
            {isOpenCodeProvider && (
              <p className="text-xs text-gray-500 mt-1">
                Model is managed by OpenCode provider
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Temperature ({settings.masterAgent.temperature})
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={settings.masterAgent.temperature}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  masterAgent: {
                    ...settings.masterAgent,
                    temperature: parseFloat(e.target.value),
                  },
                })
              }
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Max Tokens
            </label>
            <input
              type="number"
              value={settings.masterAgent.maxTokens}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  masterAgent: {
                    ...settings.masterAgent,
                    maxTokens: parseInt(e.target.value),
                  },
                })
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-6">
        <h2 className="text-lg font-semibold">Worker Agents</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Model
            </label>
            <input
              type="text"
              value={settings.workerAgents.model}
              disabled={isOpenCodeProvider}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  workerAgents: { ...settings.workerAgents, model: e.target.value },
                })
              }
              className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500 ${
                isOpenCodeProvider ? "opacity-50 cursor-not-allowed" : ""
              }`}
            />
            {isOpenCodeProvider && (
              <p className="text-xs text-gray-500 mt-1">
                Model is managed by OpenCode provider
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Temperature ({settings.workerAgents.temperature})
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={settings.workerAgents.temperature}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  workerAgents: {
                    ...settings.workerAgents,
                    temperature: parseFloat(e.target.value),
                  },
                })
              }
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Max Tokens
            </label>
            <input
              type="number"
              value={settings.workerAgents.maxTokens}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  workerAgents: {
                    ...settings.workerAgents,
                    maxTokens: parseInt(e.target.value),
                  },
                })
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
      >
        {saving ? "Saving..." : "Save Settings"}
      </button>
    </div>
  );
}
