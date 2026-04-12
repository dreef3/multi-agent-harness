/**
 * Harness planning tools — pi extension.
 *
 * Registers write_planning_document as a native pi tool by calling the
 * harness backend's REST endpoint (POST /api/tools/write-planning-document).
 *
 * Required env vars (set by the harness when launching the planning container):
 *   HARNESS_API_URL — e.g. http://backend:3000/api
 *   MCP_TOKEN       — MCP auth token
 *   PROJECT_ID      — harness project UUID
 *
 * Loaded via --extension flag in pi-planning-wrapper.sh.
 *
 * @param {import("@mariozechner/pi-coding-agent").ExtensionAPI} pi
 */
export default function (pi) {
  pi.registerTool({
    name: "write_planning_document",
    label: "Write Planning Document",
    description:
      'Write a planning document (spec or plan) to the project\'s planning branch and open/update the GitHub PR. ' +
      'Call with type "spec" first (after Phase 1 LGTM) to commit the design spec and open the PR. ' +
      'Call with type "plan" after writing the full implementation plan. ' +
      'Returns { prUrl: string }.',

    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["spec", "plan"],
          description: '"spec" for design spec (Phase 1→2 transition), "plan" for implementation plan (Phase 2→3 transition)',
        },
        content: {
          type: "string",
          description: "Full Markdown content of the document",
        },
      },
      required: ["type", "content"],
    },

    async execute(_toolCallId, params) {
      const harnessUrl = process.env.HARNESS_API_URL;
      const mcpToken = process.env.MCP_TOKEN;
      const projectId = process.env.PROJECT_ID;

      if (!harnessUrl || !mcpToken || !projectId) {
        return {
          content: [{ type: "text", text: "Error: HARNESS_API_URL, MCP_TOKEN, or PROJECT_ID not set in environment" }],
          details: {},
        };
      }

      let result;
      try {
        const response = await fetch(`${harnessUrl}/api/tools/write-planning-document`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mcpToken}`,
          },
          body: JSON.stringify({
            projectId,
            type: params.type,
            content: params.content,
          }),
        });

        result = await response.json();

        if (!response.ok) {
          const msg = result?.error ?? `HTTP ${response.status}`;
          return {
            content: [{ type: "text", text: `Error: ${msg}` }],
            details: {},
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Network error calling harness: ${err.message}` }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
