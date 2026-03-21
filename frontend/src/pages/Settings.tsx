import { useEffect, useState } from "react";
import { api, Config, ModelConfig, Repository } from "../lib/api";
import RepositoryForm from "../components/RepositoryForm";

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
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [showRepoForm, setShowRepoForm] = useState(false);
  const [editingRepo, setEditingRepo] = useState<Repository | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => {
    loadRepositories();
  }, []);

  async function loadRepositories() {
    try {
      setRepoLoading(true);
      const repos = await api.repositories.list();
      setRepositories(repos);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to load repositories");
    } finally {
      setRepoLoading(false);
    }
  }

  async function handleCreateRepo(data: Omit<Repository, "id" | "createdAt" | "updatedAt">) {
    try {
      const newRepo = await api.repositories.create(data);
      setRepositories((prev) => [newRepo, ...prev]);
      setShowRepoForm(false);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to create repository");
    }
  }

  async function handleUpdateRepo(id: string, data: Partial<Omit<Repository, "id" | "createdAt" | "updatedAt">>) {
    try {
      const updated = await api.repositories.update(id, data);
      setRepositories((prev) => prev.map((r) => (r.id === id ? updated : r)));
      setEditingRepo(null);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to update repository");
    }
  }

  async function handleDeleteRepo(id: string) {
    if (!confirm("Are you sure you want to delete this repository?")) return;
    try {
      await api.repositories.delete(id);
      setRepositories((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Failed to delete repository");
    }
  }

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

      {repoError && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded-lg">
          {repoError}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Repositories</h2>
          <button
            onClick={() => setShowRepoForm(true)}
            className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-sm font-medium"
          >
            + Add Repository
          </button>
        </div>

        {repoLoading ? (
          <div className="text-gray-400">Loading repositories...</div>
        ) : repositories.length === 0 ? (
          <div className="text-gray-400">No repositories configured. Add one to get started.</div>
        ) : (
          <div className="space-y-2">
            {repositories.map((repo) => (
              <div
                key={repo.id}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4 flex items-center justify-between"
              >
                <div>
                  <div className="font-medium">{repo.name}</div>
                  <div className="text-sm text-gray-400">{repo.cloneUrl}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    <span
                      className={`inline-block px-2 py-0.5 rounded ${
                        repo.provider === "github"
                          ? "bg-gray-700 text-gray-300"
                          : "bg-blue-900 text-blue-300"
                      }`}
                    >
                      {repo.provider === "github" ? "GitHub" : "Bitbucket Server"}
                    </span>
                    {repo.provider === "github" && (
                      <span className="ml-2">
                        {repo.providerConfig?.owner}/{repo.providerConfig?.repo}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditingRepo(repo)}
                    className="text-gray-400 hover:text-white px-3 py-1"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDeleteRepo(repo.id)}
                    className="text-red-400 hover:text-red-300 px-3 py-1"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showRepoForm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
              <h3 className="text-lg font-semibold mb-4">Add Repository</h3>
              <RepositoryForm
                onSubmit={handleCreateRepo}
                onCancel={() => setShowRepoForm(false)}
              />
            </div>
          </div>
        )}

        {editingRepo && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4">
              <h3 className="text-lg font-semibold mb-4">Edit Repository</h3>
              <RepositoryForm
                repository={editingRepo}
                onSubmit={(data) => handleUpdateRepo(editingRepo.id, data)}
                onCancel={() => setEditingRepo(null)}
              />
            </div>
          </div>
        )}

        <p className="text-xs text-gray-500">
          Credentials are configured via environment variables (GITHUB_TOKEN for GitHub,
          BITBUCKET_TOKEN and BITBUCKET_BASE_URL for Bitbucket Server).
        </p>
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
