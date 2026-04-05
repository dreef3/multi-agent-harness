export const getBuildStatusTool = {
  name: "get_build_status",
  description: "Get CI build status for a pull request",
  inputSchema: {
    type: "object" as const,
    properties: {
      pullRequestId: { type: "string", description: "Pull request ID" },
    },
    required: ["pullRequestId"],
  },
  async execute(args: Record<string, unknown>, _context: { projectId: string }) {
    const { config } = await import("../../config.js");
    const res = await fetch(`${config.harnessApiUrl}/api/pull-requests/${args.pullRequestId}/build-status`);
    if (!res.ok) return { isError: true, content: [{ type: "text" as const, text: `HTTP ${res.status}` }] };
    const data = await res.json();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  },
};
