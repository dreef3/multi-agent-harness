import { getAcpAgentManager } from "../../orchestrator/acpAgentManager.js";

export const replyToSubagentTool = {
  name: "reply_to_subagent",
  description: "Send a reply or follow-up message to a specific sub-agent (planning agent only)",
  inputSchema: {
    type: "object" as const,
    properties: {
      agentId: {
        type: "string",
        description: "The sub-agent ID (e.g. sub-<taskId>)",
      },
      message: {
        type: "string",
        description: "The message to send to the sub-agent",
      },
    },
    required: ["agentId", "message"],
  },
  async execute(
    args: Record<string, unknown>,
    _context: { projectId: string; sessionId?: string; role?: string }
  ) {
    const agentId = args.agentId as string;
    const message = args.message as string;
    // Use AcpAgentManager to send a prompt to the sub-agent if it is running.
    // Full wiring to recoveryService / task completion handling is deferred to Task 12-13.
    let manager;
    try {
      manager = getAcpAgentManager();
    } catch {
      return { content: [{ type: "text" as const, text: "TODO: reply_to_subagent not yet wired (AcpAgentManager not initialised)" }] };
    }

    if (!manager.isRunning(agentId)) {
      return { content: [{ type: "text" as const, text: `Sub-agent ${agentId} is not running` }] };
    }

    try {
      await manager.sendPrompt(agentId, message);
      return { content: [{ type: "text" as const, text: `Message sent to sub-agent ${agentId}` }] };
    } catch (err: unknown) {
      return { isError: true, content: [{ type: "text" as const, text: `Failed to send message to sub-agent ${agentId}: ${(err as Error).message}` }] };
    }
  },
};
