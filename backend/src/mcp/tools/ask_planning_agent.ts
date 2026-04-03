import { getAcpAgentManager } from "../../orchestrator/acpAgentManager.js";

export const askPlanningAgentTool = {
  name: "ask_planning_agent",
  description: "Send a question or message to the planning agent (for sub-agents only)",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: { type: "string", description: "The question to ask the planning agent" },
    },
    required: ["question"],
  },
  async execute(args: Record<string, unknown>, context: { projectId: string; sessionId?: string; role?: string }) {
    const manager = getAcpAgentManager();
    const planningAgentId = `planning-${context.projectId}`;
    if (!manager.isRunning(planningAgentId)) {
      return { content: [{ type: "text" as const, text: "Planning agent is not running" }] };
    }
    try {
      await manager.sendPrompt(planningAgentId, `Sub-agent question: ${args.question as string}`);
      return { content: [{ type: "text" as const, text: "Question sent to planning agent" }] };
    } catch (err: unknown) {
      return { isError: true, content: [{ type: "text" as const, text: `Failed to send question to planning agent: ${(err as Error).message}` }] };
    }
  },
};
