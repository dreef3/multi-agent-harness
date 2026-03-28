import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Project } from "../lib/api";

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      setLoading(true);
      const data = await api.projects.list();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this project?")) return;
    try {
      await api.projects.delete(id);
      setProjects(projects.filter((p) => p.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete project");
    }
  }

  async function handleRetry(id: string) {
    setRetrying((prev) => new Set([...prev, id]));
    try {
      await api.projects.retry(id);
      await loadProjects();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to retry project");
    } finally {
      setRetrying((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
    }
  }

  const statusColors: Record<string, string> = {
    draft: "bg-gray-700",
    brainstorming: "bg-gray-600",
    spec_in_progress: "bg-blue-600",
    awaiting_spec_approval: "bg-amber-600",
    plan_in_progress: "bg-blue-600",
    awaiting_plan_approval: "bg-amber-600",
    executing: "bg-blue-700",
    completed: "bg-purple-600",
    failed: "bg-red-600",
    cancelled: "bg-gray-700",
    error: "bg-red-600",
  };

  const statusLabels: Record<string, string> = {
    draft: "Draft",
    brainstorming: "Brainstorming",
    spec_in_progress: "Writing Spec",
    awaiting_spec_approval: "Awaiting Spec Approval",
    plan_in_progress: "Writing Plan",
    awaiting_plan_approval: "Awaiting Plan Approval",
    executing: "Executing",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    error: "Error",
  };

  if (loading) return <div className="text-gray-400">Loading...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;

  const activeProjects = projects.filter((p) => p.status !== "completed");
  const completedProjects = projects.filter((p) => p.status === "completed");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <div className="flex items-center gap-4">
          <Link
            to="/projects/new"
            className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium"
          >
            + New Project
          </Link>
        </div>
      </div>

      {activeProjects.length === 0 ? (
        <div className="text-gray-500 text-center py-12">
          No projects yet. Create your first project to get started.
        </div>
      ) : (
        <div className="grid gap-4">
          {activeProjects.map((project) => {
            const isCompleted = project.status === "completed";
            const cardClass = `bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between ${isCompleted ? "opacity-70" : ""}`;
            const badgeClass = isCompleted
              ? "text-xs px-2 py-1 rounded-full bg-gray-600 text-gray-200"
              : `text-xs px-2 py-1 rounded-full ${statusColors[project.status] || "bg-gray-700"}`;

            return (
              <article
                key={project.id}
                aria-label={`Project ${project.name} ${isCompleted ? "— Completed" : ""}`}
                className={cardClass}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-lg">{project.name}</h3>
                    <span className={badgeClass}>
                      {statusLabels[project.status] ?? project.status}
                    </span>
                  </div>
                  <p className="text-gray-400 text-sm">{project.description}</p>
                  <p className="text-gray-500 text-xs">
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </p>
                  {project.lastError && (
                    <p className="text-red-400 text-xs mt-1">{project.lastError}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    to={`/projects/${project.id}/chat`}
                    className="text-blue-400 hover:text-blue-300 px-3 py-1 text-sm"
                  >
                    Chat
                  </Link>
                  {(project.status === "awaiting_spec_approval" || project.status === "awaiting_plan_approval") && project.planningPr?.url && (
                    <a
                      href={project.planningPr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 hover:text-amber-300 px-3 py-1 text-sm"
                    >
                      Review PR ↗
                    </a>
                  )}
                  {!isCompleted && (
                    <Link
                      to={`/projects/${project.id}/execute`}
                      className="text-purple-400 hover:text-purple-300 px-3 py-1 text-sm"
                    >
                      Execute
                    </Link>
                  )}
                  {(project.status === "failed" || project.status === "error") && !isCompleted && (
                    <button
                      onClick={() => handleRetry(project.id)}
                      disabled={retrying.has(project.id)}
                      className="text-green-400 hover:text-green-300 disabled:text-gray-600 disabled:cursor-not-allowed px-3 py-1 text-sm"
                    >
                      {retrying.has(project.id) ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(project.id)}
                    className="text-red-400 hover:text-red-300 px-3 py-1 text-sm"
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Expander control and completed region - render regardless of activeProjects */}
      {completedProjects.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide completed projects' : 'Show completed projects'}
            aria-controls="completed-projects-region"
            onClick={() => setExpanded((s) => !s)}
            className="w-full flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-300 hover:text-gray-200 transition-colors"
          >
            <span>{expanded ? 'Hide completed projects' : `Show ${completedProjects.length} completed projects`}</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-5 h-5 text-gray-400 transform transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 011.08 1.04l-4.25 4.25a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>

          <div
            id="completed-projects-region"
            role="region"
            className={`overflow-hidden transition-all duration-200 ${expanded ? 'max-h-[2000px] mt-4' : 'max-h-0'}`}
          >
            {expanded ? (
              <div className="grid gap-4 mt-2">
                {completedProjects.map((project) => {
                  const isCompleted = project.status === "completed";
                  const cardClass = `bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between ${isCompleted ? "opacity-70" : ""}`;
                  const badgeClass = isCompleted
                    ? "text-xs px-2 py-1 rounded-full bg-gray-600 text-gray-200"
                    : `text-xs px-2 py-1 rounded-full ${statusColors[project.status] || "bg-gray-700"}`;

                  return (
                    <article
                      key={project.id}
                      aria-label={`Project ${project.name} ${isCompleted ? "— Completed" : ""}`}
                      className={cardClass}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <h3 className="font-semibold text-lg">{project.name}</h3>
                          <span className={badgeClass}>
                            {statusLabels[project.status] ?? project.status}
                          </span>
                        </div>
                        <p className="text-gray-400 text-sm">{project.description}</p>
                        <p className="text-gray-500 text-xs">
                          Created {new Date(project.createdAt).toLocaleDateString()}
                        </p>
                        {project.lastError && (
                          <p className="text-red-400 text-xs mt-1">{project.lastError}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/projects/${project.id}/chat`}
                          className="text-blue-400 hover:text-blue-300 px-3 py-1 text-sm"
                        >
                          Chat
                        </Link>
                        {(project.status === "awaiting_spec_approval" || project.status === "awaiting_plan_approval") && project.planningPr?.url && (
                          <a
                            href={project.planningPr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-amber-400 hover:text-amber-300 px-3 py-1 text-sm"
                          >
                            Review PR ↗
                          </a>
                        )}
                        {!isCompleted && (
                          <Link
                            to={`/projects/${project.id}/execute`}
                            className="text-purple-400 hover:text-purple-300 px-3 py-1 text-sm"
                          >
                            Execute
                          </Link>
                        )}
                        {(project.status === "failed" || project.status === "error") && !isCompleted && (
                          <button
                            onClick={() => handleRetry(project.id)}
                            disabled={retrying.has(project.id)}
                            className="text-green-400 hover:text-green-300 disabled:text-gray-600 disabled:cursor-not-allowed px-3 py-1 text-sm"
                          >
                            {retrying.has(project.id) ? "Retrying…" : "Retry"}
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(project.id)}
                          className="text-red-400 hover:text-red-300 px-3 py-1 text-sm"
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
