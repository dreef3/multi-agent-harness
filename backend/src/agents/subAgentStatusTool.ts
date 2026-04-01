import { Type } from "@sinclair/typebox";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { listAgentSessions } from "../store/agents.js";
import { getProject } from "../store/projects.js";

const SubAgentStatusParams = Type.Object({});

export function createSubAgentStatusTool(projectId: string): ToolDefinition<typeof SubAgentStatusParams> {
  return {
    name: "get_subagent_status",
    label: "Get Sub-agent Status",
    description:
      "Returns the current status of all sub-agent sessions for this project, including which tasks are running, completed, or failed. Call this when the user asks about sub-agent progress.",
    parameters: SubAgentStatusParams,
    async execute(_toolCallId, _args) {
      const [project, sessions] = await Promise.all([
        getProject(projectId),
        listAgentSessions(projectId),
      ]);

      const subSessions = sessions.filter(s => s.type === "sub");
      const summary = {
        projectStatus: project?.status ?? "unknown",
        totalTasks: project?.plan?.tasks?.length ?? 0,
        subAgentSessions: subSessions.map(s => ({
          id: s.id,
          taskId: s.taskId ?? null,
          status: s.status,
          containerId: s.containerId ? s.containerId.slice(0, 12) : null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
        counts: {
          starting: subSessions.filter(s => s.status === "starting").length,
          running: subSessions.filter(s => s.status === "running").length,
          completed: subSessions.filter(s => s.status === "completed").length,
          failed: subSessions.filter(s => s.status === "failed").length,
        },
      };

      console.log(`[subAgentStatusTool:${projectId}] status queried: ${JSON.stringify(summary.counts)}`);

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        details: {},
      } satisfies AgentToolResult<unknown>;
    },
  };
}
