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
    args: { agentId: string; message: string },
    _context: { projectId: string }
  ) {
    // Use AcpAgentManager to send a prompt to the sub-agent if it is running.
    // Full wiring to recoveryService / task completion handling is deferred to Task 12-13.
    let manager;
    try {
      manager = getAcpAgentManager();
    } catch {
      return { content: [{ type: "text" as const, text: "TODO: reply_to_subagent not yet wired (AcpAgentManager not initialised)" }] };
    }

    if (!manager.isRunning(args.agentId)) {
      return { content: [{ type: "text" as const, text: `Sub-agent ${args.agentId} is not running` }] };
    }

    await manager.sendPrompt(args.agentId, args.message);
    return { content: [{ type: "text" as const, text: `Message sent to sub-agent ${args.agentId}` }] };
  },
};
