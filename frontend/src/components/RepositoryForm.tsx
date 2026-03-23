import { useState, useEffect } from "react";
import type { Repository, GitHubRepoInfo } from "../lib/api";
import { api } from "../lib/api";

interface RepositoryFormProps {
  repository?: Repository;
  onSubmit: (data: Omit<Repository, "id" | "createdAt" | "updatedAt">) => void;
  onCancel: () => void;
}

export default function RepositoryForm({ repository, onSubmit, onCancel }: RepositoryFormProps) {
  const [name, setName] = useState(repository?.name ?? "");
  const [provider, setProvider] = useState<"github" | "bitbucket-server">(
    repository?.provider ?? "github"
  );
  const [cloneUrl, setCloneUrl] = useState(repository?.cloneUrl ?? "");
  const [defaultBranch, setDefaultBranch] = useState(repository?.defaultBranch ?? "main");

  const [owner, setOwner] = useState(repository?.providerConfig?.owner ?? "");
  const [repoName, setRepoName] = useState(repository?.providerConfig?.repo ?? "");

  const [baseUrl, setBaseUrl] = useState(repository?.providerConfig?.baseUrl ?? "");
  const [projectKey, setProjectKey] = useState(repository?.providerConfig?.projectKey ?? "");
  const [repoSlug, setRepoSlug] = useState(repository?.providerConfig?.repoSlug ?? "");

  // GitHub picker state
  const [showGitHubPicker, setShowGitHubPicker] = useState(false);
  const [githubRepos, setGithubRepos] = useState<GitHubRepoInfo[]>([]);
  const [loadingGitHubRepos, setLoadingGitHubRepos] = useState(false);
  const [githubReposError, setGithubReposError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Check if GitHub is configured and load repositories
  useEffect(() => {
    if (showGitHubPicker && githubRepos.length === 0 && !loadingGitHubRepos) {
      loadGitHubRepos();
    }
  }, [showGitHubPicker]);

  async function loadGitHubRepos() {
    try {
      setLoadingGitHubRepos(true);
      setGithubReposError(null);
      const repos = await api.repositories.listGitHub();
      setGithubRepos(repos);
    } catch (err) {
      setGithubReposError(err instanceof Error ? err.message : "Failed to load GitHub repositories");
      console.error("Failed to load GitHub repositories:", err);
    } finally {
      setLoadingGitHubRepos(false);
    }
  }

  function handleGitHubRepoSelect(repo: GitHubRepoInfo) {
    setName(repo.name);
    setCloneUrl(repo.cloneUrl);
    setOwner(repo.owner);
    setRepoName(repo.repo);
    setDefaultBranch(repo.defaultBranch);
    setShowGitHubPicker(false);
    setSearchQuery("");
  }

  function handleSubmit (e: React.FormEvent) {
    e.preventDefault();

    const providerConfig = provider === "github"
      ? { owner, repo: repoName }
      : { baseUrl, projectKey, repoSlug };

    onSubmit({
      name,
      cloneUrl,
      provider,
      providerConfig,
      defaultBranch,
    });
  };

  const isGitHub = provider === "github";

  // Filter repos based on search query
  const filteredRepos = githubRepos.filter(repo =>
    repo.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (repo.description && repo.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const isValid = name && cloneUrl && (isGitHub ? owner && repoName : baseUrl && projectKey && repoSlug);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* GitHub Picker Modal */}
      {showGitHubPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Select GitHub Repository</h3>
              <button
                type="button"
                onClick={() => {
                  setShowGitHubPicker(false);
                  setSearchQuery("");
                }}
                className="text-gray-400 hover:text-white text-2xl leading-none"
              >
                &times;
              </button>
            </div>

            {loadingGitHubRepos ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-gray-400">Loading repositories...</div>
              </div>
            ) : githubReposError ? (
              <div className="flex-1">
                <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded-lg mb-4">
                  {githubReposError}
                </div>
                <button
                  type="button"
                  onClick={loadGitHubRepos}
                  className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium"
                >
                  Retry
                </button>
              </div>
            ) : (
              <>
                <div className="mb-4">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search repositories..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                </div>

                <div className="flex-1 overflow-y-auto space-y-2 max-h-[400px]">
                  {filteredRepos.length === 0 ? (
                    <div className="text-gray-400 text-center py-4">
                      {searchQuery ? "No matching repositories" : "No repositories found"}
                    </div>
                  ) : (
                    filteredRepos.map((repo) => (
                      <button
                        key={repo.fullName}
                        type="button"
                        onClick={() => handleGitHubRepoSelect(repo)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-left hover:border-blue-500 transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-white">{repo.fullName}</div>
                            {repo.description && (
                              <div className="text-sm text-gray-400 mt-1">{repo.description}</div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {repo.private && (
                              <span className="text-xs bg-yellow-900/50 text-yellow-300 px-2 py-0.5 rounded">
                                Private
                              </span>
                            )}
                            <span className="text-xs text-gray-500">
                              Default: {repo.defaultBranch}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>

                <div className="mt-4 pt-4 border-t border-gray-700">
                  <p className="text-xs text-gray-500">
                    Showing {filteredRepos.length} of {githubRepos.length} repositories
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* GitHub Quick Select Button */}
      {isGitHub && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setShowGitHubPicker(true)}
            className="flex-1 bg-gray-800 border border-gray-700 hover:border-blue-500 rounded-lg px-4 py-3 text-left transition-colors"
          >
            <div className="flex items-center gap-3">
              <svg className="w-8 h-8 text-gray-300" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              <div>
                <div className="font-medium text-white">Select from GitHub</div>
                <div className="text-sm text-gray-400">Pick an accessible repository</div>
              </div>
            </div>
          </button>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Display Name *
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Repository"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Provider *
        </label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as "github" | "bitbucket-server")}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
        >
          <option value="github">GitHub</option>
          <option value="bitbucket-server">Bitbucket Server</option>
        </select>
      </div>

      {isGitHub ? (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Owner *
            </label>
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="org-name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repository Name *
            </label>
            <input
              type="text"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="repo-name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Base URL *
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://bitbucket.company.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Project Key *
            </label>
            <input
              type="text"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              placeholder="PROJ"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Repository Slug *
            </label>
            <input
              type="text"
              value={repoSlug}
              onChange={(e) => setRepoSlug(e.target.value)}
              placeholder="repo-slug"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
        </>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Clone URL *
        </label>
        <input
          type="url"
          value={cloneUrl}
          onChange={(e) => setCloneUrl(e.target.value)}
          placeholder="https://github.com/org/repo.git"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Default Branch
        </label>
        <input
          type="text"
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="main"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={!isValid}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-4 py-2 rounded-lg font-medium"
        >
          {repository ? "Update" : "Add"} Repository
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-medium"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
