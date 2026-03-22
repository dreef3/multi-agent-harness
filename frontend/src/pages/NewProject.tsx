import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, Repository } from "../lib/api";

interface JiraIssue {
  key: string;
  summary: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  created: string;
  updated: string;
  labels: string[];
  issuetype: string;
}

interface GitHubIssue {
  ref: string;          // "owner/repo#123"
  number: number;
  title: string;
  body?: string;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  repository: string;
}

export default function NewProject() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // JIRA integration state
  const [jqlQuery, setJqlQuery] = useState("");
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([]);
  const [selectedIssues, setSelectedIssues] = useState<string[]>([]);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [showJiraPicker, setShowJiraPicker] = useState(false);

  // GitHub Issues integration state
  const [ghQuery, setGhQuery] = useState("");
  const [ghIssues, setGhIssues] = useState<GitHubIssue[]>([]);
  const [selectedGhIssues, setSelectedGhIssues] = useState<string[]>([]);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [showGhPicker, setShowGhPicker] = useState(false);
  
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [primaryRepoId, setPrimaryRepoId] = useState<string | null>(null);
  const [repoLoading, setRepoLoading] = useState(true);
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);

  // Auto-select primary repo when only one is selected
  useEffect(() => {
    if (selectedRepoIds.length === 1) {
      setPrimaryRepoId(selectedRepoIds[0]);
    } else if (!selectedRepoIds.includes(primaryRepoId ?? "")) {
      setPrimaryRepoId(null);
    }
  }, [selectedRepoIds]);

  // GitHub Issues are only valid when all selected repos are GitHub-hosted
  const selectedRepos = repositories.filter(r => selectedRepoIds.includes(r.id));
  const hasNonGithubRepo = selectedRepos.some(r => r.provider !== "github");
  const canUseGhIssues = selectedRepoIds.length === 0 || !hasNonGithubRepo;
  
  useEffect(() => {
    loadRepositories();
  }, []);

  async function loadRepositories() {
    try {
      setRepoLoading(true);
      const repos = await api.repositories.list();
      setRepositories(repos);
    } catch (err) {
      console.error("Failed to load repositories:", err);
    } finally {
      setRepoLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (selectedRepoIds.length === 0) {
      setError("Please select at least one repository");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      let finalDescription = description;
      if (selectedIssues.length > 0) {
        const jiraContext = selectedIssues
          .map(key => jiraIssues.find(i => i.key === key))
          .filter(Boolean)
          .map(issue => `[${issue!.key}] ${issue!.summary}`)
          .join("\n");
        finalDescription = `${finalDescription}\n\nJIRA Tickets:\n${jiraContext}`;
      }
      if (selectedGhIssues.length > 0) {
        const ghContext = selectedGhIssues
          .map(ref => ghIssues.find(i => i.ref === ref))
          .filter(Boolean)
          .map(issue => {
            const parts: string[] = [`[${issue!.ref}] ${issue!.title}`];
            if (issue!.body?.trim()) parts.push(issue!.body.trim());
            if (issue!.labels.length > 0) parts.push(`Labels: ${issue!.labels.join(", ")}`);
            if (issue!.assignees.length > 0) parts.push(`Assignees: ${issue!.assignees.join(", ")}`);
            return parts.join("\n");
          })
          .join("\n\n---\n\n");
        finalDescription = finalDescription.trim()
          ? `${finalDescription.trim()}\n\n${ghContext}`
          : ghContext;
      }

      const source =
        selectedGhIssues.length > 0
          ? { type: "github" as const, githubIssues: selectedGhIssues, freeformDescription: finalDescription.trim() }
          : selectedIssues.length > 0
          ? { type: "jira" as const, jiraTickets: selectedIssues, freeformDescription: finalDescription.trim() }
          : { type: "freeform" as const, freeformDescription: finalDescription.trim() };

      const project = await api.projects.create({
        name: name.trim(),
        repositoryIds: selectedRepoIds,
        primaryRepositoryId: primaryRepoId ?? selectedRepoIds[0],
        source,
      });
      navigate(`/projects/${project.id}/chat`, { state: { project } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  async function searchJiraIssues() {
    if (!jqlQuery.trim()) return;
    
    try {
      setJiraLoading(true);
      setJiraError(null);
      
      const response = await fetch(`/api/jira/search?jql=${encodeURIComponent(jqlQuery)}&maxResults=20`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to search JIRA");
      }
      
      const data = await response.json();
      setJiraIssues(data.issues || []);
    } catch (err) {
      setJiraError(err instanceof Error ? err.message : "Failed to search JIRA");
    } finally {
      setJiraLoading(false);
    }
  }

  function toggleIssueSelection(key: string) {
    setSelectedIssues(prev => 
      prev.includes(key) 
        ? prev.filter(k => k !== key)
        : [...prev, key]
    );
  }

  function addSelectedIssuesToDescription() {
    const selectedIssuesData = selectedIssues
      .map(key => jiraIssues.find(i => i.key === key))
      .filter(Boolean);

    if (selectedIssuesData.length === 0) return;

    const jiraText = selectedIssuesData
      .map(issue => `[${issue!.key}] ${issue!.summary}\n${issue!.description || ""}`)
      .join("\n\n---\n\n");

    setDescription(prev => prev ? `${prev}\n\n${jiraText}` : jiraText);
    setShowJiraPicker(false);
  }

  async function searchGitHubIssues() {
    if (selectedRepoIds.length === 0) {
      setGhError("Select at least one repository first");
      return;
    }

    try {
      setGhLoading(true);
      setGhError(null);

      const params = new URLSearchParams({
        repositoryIds: selectedRepoIds.join(","),
        maxResults: "20",
      });
      if (ghQuery.trim()) {
        params.set("q", ghQuery.trim());
      }

      const response = await fetch(`/api/github-issues/search?${params}`);
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to search GitHub Issues");
      }

      const data = await response.json();
      setGhIssues(data.issues || []);
    } catch (err) {
      setGhError(err instanceof Error ? err.message : "Failed to search GitHub Issues");
    } finally {
      setGhLoading(false);
    }
  }

  function toggleGhIssueSelection(ref: string) {
    setSelectedGhIssues(prev =>
      prev.includes(ref) ? prev.filter(r => r !== ref) : [...prev, ref]
    );
  }

  function addSelectedGhIssuesToDescription() {
    const selected = selectedGhIssues
      .map(ref => ghIssues.find(i => i.ref === ref))
      .filter(Boolean);

    if (selected.length === 0) return;

    const ghText = selected
      .map(issue => {
        const body = issue!.body ? `\n\`\`\`\n${issue!.body}\n\`\`\`` : "";
        return `[${issue!.ref}] ${issue!.title}${body}`;
      })
      .join("\n\n---\n\n");

    setDescription(prev => prev ? `${prev}\n\n${ghText}` : ghText);
    setShowGhPicker(false);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Create New Project</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Project Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Awesome Project"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            required
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-300">
              Description
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowJiraPicker(!showJiraPicker);
                  if (!showJiraPicker) {
                    setShowGhPicker(false);
                    setSelectedGhIssues([]);
                    setGhIssues([]);
                  }
                }}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                {showJiraPicker ? "Hide JIRA Picker" : "+ Add JIRA Tickets"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!canUseGhIssues) return;
                  setShowGhPicker(!showGhPicker);
                  if (!showGhPicker) {
                    setShowJiraPicker(false);
                    setSelectedIssues([]);
                    setJiraIssues([]);
                  }
                }}
                disabled={!canUseGhIssues}
                title={hasNonGithubRepo ? "GitHub Issues are only available when all selected repositories are hosted on GitHub" : undefined}
                className={`text-xs ${canUseGhIssues ? "text-purple-400 hover:text-purple-300" : "text-gray-600 cursor-not-allowed"}`}
              >
                {showGhPicker ? "Hide GitHub Issues" : "+ Add GitHub Issues"}
              </button>
            </div>
          </div>
          
          {showJiraPicker && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-3 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={jqlQuery}
                  onChange={(e) => setJqlQuery(e.target.value)}
                  placeholder="project = PROJ AND status = 'In Progress'"
                  className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), searchJiraIssues())}
                />
                <button
                  type="button"
                  onClick={searchJiraIssues}
                  disabled={jiraLoading || !jqlQuery.trim()}
                  className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 px-4 py-2 rounded text-sm font-medium"
                >
                  {jiraLoading ? "Searching..." : "Search"}
                </button>
              </div>

              {jiraError && (
                <div className="text-red-400 text-sm">{jiraError}</div>
              )}

              {jiraIssues.length > 0 && (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {jiraIssues.map(issue => (
                    <div
                      key={issue.key}
                      onClick={() => toggleIssueSelection(issue.key)}
                      className={`p-2 rounded cursor-pointer transition-colors ${
                        selectedIssues.includes(issue.key)
                          ? "bg-blue-900/50 border border-blue-500"
                          : "bg-gray-800 hover:bg-gray-750 border border-gray-700"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedIssues.includes(issue.key)}
                          onChange={() => {}}
                          className="rounded"
                        />
                        <span className="font-medium text-sm">{issue.key}</span>
                        <span className="text-xs text-gray-400">{issue.status}</span>
                      </div>
                      <div className="text-sm text-gray-300 ml-6">{issue.summary}</div>
                    </div>
                  ))}
                </div>
              )}

              {selectedIssues.length > 0 && (
                <div className="flex items-center justify-between pt-2 border-t border-gray-700">
                  <span className="text-sm text-gray-400">
                    {selectedIssues.length} issue(s) selected
                  </span>
                  <button
                    type="button"
                    onClick={addSelectedIssuesToDescription}
                    className="bg-green-600 hover:bg-green-500 px-4 py-2 rounded text-sm font-medium"
                  >
                    Add to Description
                  </button>
                </div>
              )}
            </div>
          )}

          {showGhPicker && (
            <div className="bg-gray-900 border border-purple-900 rounded-lg p-4 mb-3 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ghQuery}
                  onChange={(e) => setGhQuery(e.target.value)}
                  placeholder="Search open issues by title..."
                  className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), searchGitHubIssues())}
                />
                <button
                  type="button"
                  onClick={searchGitHubIssues}
                  disabled={ghLoading || selectedRepoIds.length === 0}
                  className="bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 px-4 py-2 rounded text-sm font-medium"
                >
                  {ghLoading ? "Searching..." : "Search"}
                </button>
              </div>

              {selectedRepoIds.length === 0 && (
                <div className="text-yellow-400 text-sm">Select repositories above to search their issues.</div>
              )}

              {ghError && (
                <div className="text-red-400 text-sm">{ghError}</div>
              )}

              {ghIssues.length > 0 && (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {ghIssues.map(issue => (
                    <div
                      key={issue.ref}
                      onClick={() => toggleGhIssueSelection(issue.ref)}
                      className={`p-2 rounded cursor-pointer transition-colors ${
                        selectedGhIssues.includes(issue.ref)
                          ? "bg-purple-900/50 border border-purple-500"
                          : "bg-gray-800 hover:bg-gray-750 border border-gray-700"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedGhIssues.includes(issue.ref)}
                          onChange={() => {}}
                          className="rounded"
                        />
                        <span className="font-medium text-sm text-purple-300">{issue.ref}</span>
                        {issue.labels.length > 0 && (
                          <span className="text-xs text-gray-400">{issue.labels.join(", ")}</span>
                        )}
                      </div>
                      <div className="text-sm text-gray-300 ml-6">{issue.title}</div>
                    </div>
                  ))}
                </div>
              )}

              {selectedGhIssues.length > 0 && (
                <div className="pt-2 border-t border-gray-700">
                  <span className="text-sm text-gray-400">
                    {selectedGhIssues.length} issue(s) selected — will be included automatically
                  </span>
                </div>
              )}
            </div>
          )}
          
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What do you want to build?"
            rows={6}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Repositories *
          </label>
          {repoLoading ? (
            <div className="text-gray-400">Loading repositories...</div>
          ) : repositories.length === 0 ? (
            <div className="text-gray-400">
              No repositories configured.{" "}
              <a href="/settings" className="text-blue-400 hover:text-blue-300">
                Add repositories in Settings
              </a>
            </div>
          ) : (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRepoDropdown(!showRepoDropdown)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-left text-white focus:outline-none focus:border-blue-500"
              >
                {selectedRepoIds.length === 0
                  ? "Select repositories..."
                  : `${selectedRepoIds.length} selected`}
              </button>
              {showRepoDropdown && (
                <div className="absolute z-10 mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {repositories.map((repo) => (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => {
                        setSelectedRepoIds((prev) =>
                          prev.includes(repo.id)
                            ? prev.filter((id) => id !== repo.id)
                            : [...prev, repo.id]
                        );
                      }}
                      className={`w-full px-4 py-2 text-left hover:bg-gray-700 ${
                        selectedRepoIds.includes(repo.id) ? "bg-blue-900/50" : ""
                      }`}
                    >
                      <div className="font-medium">{repo.name}</div>
                      <div className="text-sm text-gray-400">{repo.cloneUrl}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {selectedRepoIds.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {selectedRepoIds.map((id) => {
                const repo = repositories.find((r) => r.id === id);
                if (!repo) return null;
                return (
                  <span
                    key={id}
                    className="bg-blue-900/50 border border-blue-700 rounded px-2 py-1 text-sm flex items-center gap-1"
                  >
                    {repo.name}
                    <button
                      type="button"
                      onClick={() => setSelectedRepoIds((prev) => prev.filter((rid) => rid !== id))}
                      className="text-gray-400 hover:text-white"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {selectedRepoIds.length >= 2 && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Primary Repository
                <span className="text-gray-500 font-normal ml-1">(planning branch will be created here)</span>
              </label>
              <select
                value={primaryRepoId ?? ""}
                onChange={(e) => setPrimaryRepoId(e.target.value || null)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
              >
                <option value="">Select primary repository...</option>
                {selectedRepoIds.map((id) => {
                  const repo = repositories.find((r) => r.id === id);
                  if (!repo) return null;
                  return <option key={id} value={id}>{repo.name}</option>;
                })}
              </select>
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={loading || !name.trim() || selectedRepoIds.length === 0}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
          >
            {loading ? "Creating..." : "Create Project"}
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-gray-400 hover:text-white px-4 py-2"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
