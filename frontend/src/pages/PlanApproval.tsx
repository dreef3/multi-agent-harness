import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { api, Plan } from "../lib/api";

export default function PlanApproval() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const statePlan = (location.state as { plan?: Plan } | null)?.plan ?? null;
  const [plan, setPlan] = useState<Plan | null>(statePlan);
  const [loading, setLoading] = useState(statePlan === null);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!id || statePlan !== null) return;
    loadPlan();
  }, [id]);

  async function loadPlan() {
    if (!id) return;
    try {
      // Plan endpoint not implemented - get plan from project instead
      const project = await api.projects.get(id);
      setPlan(project.plan as Plan | null);
    } catch (err) {
      console.error("Failed to load plan:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove() {
    if (!id || actionLoading) return;
    try {
      setActionLoading(true);
      await api.projects.approve(id);
      navigate(`/projects/${id}/execute`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to approve plan");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject() {
    if (!id || actionLoading || !feedback.trim()) return;
    try {
      setActionLoading(true);
      // Reject endpoint not implemented yet
      // await api.plan.reject(id, feedback.trim());
      alert("Reject not implemented yet");
      navigate(`/projects/${id}/chat`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to reject plan");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) return <div className="text-gray-400">Loading...</div>;
  if (!plan) return <div className="text-gray-400">No plan found</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Review Plan</h1>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-3 py-1 rounded-full ${
              plan.approved ? "bg-green-600" : "bg-yellow-600"
            }`}
          >
            {plan.approved ? "approved" : "pending approval"}
          </span>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">Tasks</h2>
        {plan.tasks.length === 0 ? (
          <p className="text-gray-500">No tasks in this plan yet.</p>
        ) : (
          <div className="space-y-3">
            {plan.tasks.map((task, index) => (
              <div
                key={task.id}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded">
                    {index + 1}
                  </span>
                  <div className="flex-1 space-y-2">
                    <p className="text-gray-100">{task.description}</p>
                    {task.dependsOn && task.dependsOn.length > 0 && (
                      <p className="text-gray-400 text-sm">
                        Depends on: {task.dependsOn.join(", ")}
                      </p>
                    )}
                    <span
                      className={`inline-block text-xs px-2 py-1 rounded ${
                        task.status === "completed"
                          ? "bg-green-600"
                          : task.status === "executing"
                          ? "bg-blue-600"
                          : task.status === "failed"
                          ? "bg-red-600"
                          : "bg-gray-600"
                      }`}
                    >
                      {task.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!plan.approved && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Feedback (optional for reject)</h2>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Enter feedback if rejecting the plan..."
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <div className="flex items-center gap-4">
            <button
              onClick={handleApprove}
              disabled={actionLoading}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
            >
              {actionLoading ? "Processing..." : "Approve Plan"}
            </button>
            <button
              onClick={handleReject}
              disabled={actionLoading || !feedback.trim()}
              className="bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
            >
              Reject & Provide Feedback
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate(`/projects/${id}/chat`)}
          className="text-gray-400 hover:text-white"
        >
          ← Back to Chat
        </button>
      </div>
    </div>
  );
}
