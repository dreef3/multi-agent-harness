import { Type } from "@sinclair/typebox";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { getRecoveryService } from "../orchestrator/recoveryService.js";

const RestartFailedTasksParams = Type.Object({});

export function createRestartFailedTasksTool(projectId: string): ToolDefinition<typeof RestartFailedTasksParams> {
  return {
    name: "restart_failed_tasks",
    label: "Restart Failed Tasks",
    description:
      "Re-dispatches all permanently failed tasks for this project. Resets retry counts so each task gets fresh attempts. Use this when sub-agent tasks have failed and the user wants to try again.",
    parameters: RestartFailedTasksParams,
    async execute(_toolCallId, _args) {
      const result = await getRecoveryService().dispatchFailedTasks(projectId);
      const text = result.count > 0
        ? `Re-queued ${result.count} failed task(s). Sub-agents are retrying now.`
        : `No failed tasks to re-queue (tasks may already be running or completed).`;
      console.log(`[restartFailedTasksTool:${projectId}] ${text}`);
      return {
        content: [{ type: "text", text }],
        details: {},
      } satisfies AgentToolResult<unknown>;
    },
  };
}
