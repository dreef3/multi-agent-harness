import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";

interface PullRequest {
  id: string;
  projectId: string;
  repositoryId: string;
  agentSessionId: string;
  provider: "github" | "bitbucket-server";
  externalId: string;
  url: string;
  branch: string;
  status: "open" | "merged" | "declined";
  createdAt: string;
  updatedAt: string;
}

interface ReviewComment {
  id: string;
  pullRequestId: string;
  externalId: string;
  author: string;
  body: string;
  filePath?: string;
  lineNumber?: number;
  status: "pending" | "batched" | "fixing" | "fixed" | "ignored";
  receivedAt: string;
  updatedAt: string;
}

interface PRWithComments extends PullRequest {
  comments: ReviewComment[];
}

interface DebounceInfo {
  prId: string;
  remainingMs: number;
  isActive: boolean;
}

export default function PrOverview() {
  const { id: projectId } = useParams<{ id: string }>();
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [selectedPr, setSelectedPr] = useState<PRWithComments | null>(null);
  const [debounceInfo, setDebounceInfo] = useState<Map<string, DebounceInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fixLoading, setFixLoading] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState<string | null>(null);

  // Countdown timer for debounce
  const [countdowns, setCountdowns] = useState<Map<string, number>>(new Map());

  const loadPullRequests = useCallback(async () => {
    if (!projectId) return;
    
    try {
      setLoading(true);
      setError(null);
      
      // Use the api object but we need to add the new endpoint
      const response = await fetch(`/api/pull-requests/project/${projectId}`);
      if (!response.ok) throw new Error("Failed to load pull requests");
      
      const data = await response.json();
      setPullRequests(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pull requests");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadPrDetails = async (prId: string) => {
    try {
      const response = await fetch(`/api/pull-requests/${prId}`);
      if (!response.ok) throw new Error("Failed to load PR details");
      
      const data = await response.json();
      setSelectedPr(data);
    } catch (err) {
      console.error("Failed to load PR details:", err);
    }
  };

  const syncComments = async (prId: string) => {
    try {
      setSyncLoading(prId);
      const response = await fetch(`/api/pull-requests/${prId}/sync`, {
        method: "POST",
      });
      
      if (!response.ok) throw new Error("Failed to sync comments");
      
      const result = await response.json();
      console.log(`Synced ${result.synced} comments`);
      
      // Reload PR details if currently selected
      if (selectedPr?.id === prId) {
        await loadPrDetails(prId);
      }
      
      // Reload list to get updated counts
      await loadPullRequests();
    } catch (err) {
      console.error("Failed to sync comments:", err);
      alert(err instanceof Error ? err.message : "Failed to sync comments");
    } finally {
      setSyncLoading(null);
    }
  };

  const triggerFix = async (prId: string, commentIds?: string[]) => {
    try {
      setFixLoading(prId);
      const response = await fetch(`/api/pull-requests/${prId}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentIds }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to trigger fix");
      }
      
      const result = await response.json();
      console.log(`Fixed ${result.fixed} comments`);
      
      // Reload PR details
      if (selectedPr?.id === prId) {
        await loadPrDetails(prId);
      }
      
      await loadPullRequests();
    } catch (err) {
      console.error("Failed to trigger fix:", err);
      alert(err instanceof Error ? err.message : "Failed to trigger fix");
    } finally {
      setFixLoading(null);
    }
  };

  const updateCommentStatus = async (prId: string, commentId: string, status: ReviewComment["status"]) => {
    try {
      const response = await fetch(`/api/pull-requests/${prId}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      
      if (!response.ok) throw new Error("Failed to update comment status");
      
      // Reload PR details
      if (selectedPr?.id === prId) {
        await loadPrDetails(prId);
      }
    } catch (err) {
      console.error("Failed to update comment status:", err);
    }
  };

  // Countdown timer effect
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns(prev => {
        const next = new Map(prev);
        for (const [prId, remaining] of next.entries()) {
          if (remaining <= 1000) {
            next.delete(prId);
          } else {
            next.set(prId, remaining - 1000);
          }
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Simulate debounce countdown (in a real implementation, this would come from the server)
  const startCountdown = (prId: string, durationMs: number = 10 * 60 * 1000) => {
    setCountdowns(prev => new Map(prev).set(prId, durationMs));
  };

  useEffect(() => {
    loadPullRequests();
    
    // Refresh every 30 seconds
    const interval = setInterval(loadPullRequests, 30000);
    return () => clearInterval(interval);
  }, [loadPullRequests]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "open": return "bg-green-600";
      case "merged": return "bg-purple-600";
      case "declined": return "bg-red-600";
      default: return "bg-gray-600";
    }
  };

  const getCommentStatusColor = (status: ReviewComment["status"]) => {
    switch (status) {
      case "pending": return "bg-yellow-600";
      case "batched": return "bg-blue-600";
      case "fixing": return "bg-orange-600";
      case "fixed": return "bg-green-600";
      case "ignored": return "bg-gray-600";
      default: return "bg-gray-600";
    }
  };

  const formatDuration = (ms: number): string => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  if (loading) return <div className="text-gray-400">Loading pull requests...</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Pull Requests</h1>
        <button
          onClick={loadPullRequests}
          className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium"
        >
          Refresh
        </button>
      </div>

      {pullRequests.length === 0 ? (
        <div className="text-gray-500 text-center py-12">
          No pull requests yet. Create a project and approve a plan to generate PRs.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* PR List */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-300">Pull Requests ({pullRequests.length})</h2>
            {pullRequests.map(pr => {
              const countdown = countdowns.get(pr.id);
              return (
                <div
                  key={pr.id}
                  onClick={() => loadPrDetails(pr.id)}
                  className={`bg-gray-900 border rounded-lg p-4 cursor-pointer transition-colors ${
                    selectedPr?.id === pr.id ? "border-blue-500" : "border-gray-800 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(pr.status)}`}>
                        {pr.status}
                      </span>
                      <span className="text-xs text-gray-500">{pr.provider}</span>
                    </div>
                    {countdown && (
                      <div className="text-xs text-yellow-400">
                        Auto-fix in: {formatDuration(countdown)}
                      </div>
                    )}
                  </div>
                  
                  <div className="text-sm text-gray-400 mb-2">Branch: {pr.branch}</div>
                  
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 text-sm block mb-3"
                    onClick={e => e.stopPropagation()}
                  >
                    View on {pr.provider} →
                  </a>
                  
                  <div className="flex items-center gap-2">
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        syncComments(pr.id);
                      }}
                      disabled={syncLoading === pr.id}
                      className="bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 px-3 py-1 rounded text-xs"
                    >
                      {syncLoading === pr.id ? "Syncing..." : "Sync Comments"}
                    </button>
                    
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        startCountdown(pr.id);
                      }}
                      className="bg-yellow-700 hover:bg-yellow-600 px-3 py-1 rounded text-xs"
                    >
                      Test Countdown
                    </button>
                    
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        triggerFix(pr.id);
                      }}
                      disabled={fixLoading === pr.id || pr.status !== "open"}
                      className="bg-green-700 hover:bg-green-600 disabled:bg-gray-800 px-3 py-1 rounded text-xs"
                    >
                      {fixLoading === pr.id ? "Fixing..." : "Fix Now"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* PR Details */}
          <div>
            {selectedPr ? (
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Comments</h2>
                  <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(selectedPr.status)}`}>
                    {selectedPr.status}
                  </span>
                </div>
                
                {selectedPr.comments.length === 0 ? (
                  <div className="text-gray-500 text-center py-8">
                    No pending comments on this PR.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {selectedPr.comments.map(comment => (
                      <div key={comment.id} className="bg-gray-800 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{comment.author}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${getCommentStatusColor(comment.status)}`}>
                              {comment.status}
                            </span>
                          </div>
                          <span className="text-xs text-gray-500">
                            {new Date(comment.receivedAt).toLocaleString()}
                          </span>
                        </div>
                        
                        {comment.filePath && (
                          <div className="text-xs text-gray-400 mb-1">
                            {comment.filePath}{comment.lineNumber ? `:${comment.lineNumber}` : ""}
                          </div>
                        )}
                        
                        <div className="text-sm text-gray-300 mb-3 whitespace-pre-wrap">
                          {comment.body}
                        </div>
                        
                        <div className="flex items-center gap-2">
                          {comment.status === "pending" && (
                            <>
                              <button
                                onClick={() => triggerFix(selectedPr.id, [comment.id])}
                                disabled={fixLoading === selectedPr.id}
                                className="bg-green-700 hover:bg-green-600 disabled:bg-gray-700 px-3 py-1 rounded text-xs"
                              >
                                Fix
                              </button>
                              <button
                                onClick={() => updateCommentStatus(selectedPr.id, comment.id, "ignored")}
                                className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs"
                              >
                                Ignore
                              </button>
                            </>
                          )}
                          {comment.status === "ignored" && (
                            <button
                              onClick={() => updateCommentStatus(selectedPr.id, comment.id, "pending")}
                              className="bg-yellow-700 hover:bg-yellow-600 px-3 py-1 rounded text-xs"
                            >
                              Unignore
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    
                    {selectedPr.comments.some(c => c.status === "pending") && (
                      <button
                        onClick={() => triggerFix(selectedPr.id)}
                        disabled={fixLoading === selectedPr.id}
                        className="w-full bg-green-700 hover:bg-green-600 disabled:bg-gray-700 py-2 rounded-lg font-medium mt-4"
                      >
                        {fixLoading === selectedPr.id ? "Fixing all..." : "Fix All Pending"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500">
                Select a pull request to view comments
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
