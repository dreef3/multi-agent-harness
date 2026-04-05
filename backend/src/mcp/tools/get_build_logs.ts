export const getBuildLogsTool = {
  name: "get_build_logs",
  description: "Fetch CI build logs for a specific build URL",
  inputSchema: {
    type: "object" as const,
    properties: {
      buildUrl: { type: "string", description: "Build URL from CI check" },
    },
    required: ["buildUrl"],
  },
  async execute(args: Record<string, unknown>) {
    const { config } = await import("../../config.js");
    const url = `${config.harnessApiUrl}/api/ci/logs?buildUrl=${encodeURIComponent(args.buildUrl as string)}`;
    const res = await fetch(url);
    if (!res.ok) return { isError: true, content: [{ type: "text" as const, text: `HTTP ${res.status}` }] };
    const data = await res.json() as { logs: string };
    return { content: [{ type: "text" as const, text: data.logs ?? "" }] };
  },
};
