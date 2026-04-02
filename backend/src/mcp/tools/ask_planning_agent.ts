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
  async execute(args: { question: string }, context: { projectId: string }) {
    const manager = getAcpAgentManager();
    const planningAgentId = `planning-${context.projectId}`;
    if (!manager.isRunning(planningAgentId)) {
      return { content: [{ type: "text" as const, text: "Planning agent is not running" }] };
    }
    await manager.sendPrompt(planningAgentId, `Sub-agent question: ${args.question}`);
    return { content: [{ type: "text" as const, text: "Question sent to planning agent" }] };
  },
};
