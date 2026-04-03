import { listPullRequestsByProject } from "../../store/pullRequests.js";

export const getPullRequestsTool = {
  name: "get_pull_requests",
  description: "List all pull requests for the current project",
  inputSchema: { type: "object" as const, properties: {} },
  async execute(_args: Record<string, unknown>, context: { projectId: string; sessionId?: string; role?: string }) {
    const prs = await listPullRequestsByProject(context.projectId);
    const result = prs.map((pr) => ({
      url: pr.url,
      branch: pr.branch,
      status: pr.status,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
};
