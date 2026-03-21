import { useState } from "react";
import type { Repository } from "../lib/api";

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

  const handleSubmit = (e: React.FormEvent) => {
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

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
          disabled={!name || !cloneUrl || (isGitHub ? !owner || !repoName : !baseUrl || !projectKey || !repoSlug)}
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