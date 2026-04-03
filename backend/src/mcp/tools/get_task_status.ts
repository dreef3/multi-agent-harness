import { getProject } from "../../store/projects.js";

export const getTaskStatusTool = {
  name: "get_task_status",
  description: "Get the status of all tasks for the current project",
  inputSchema: { type: "object" as const, properties: {} },
  async execute(_args: Record<string, unknown>, context: { projectId: string; sessionId?: string; role?: string }) {
    const project = await getProject(context.projectId);
    if (!project?.plan) return { content: [{ type: "text" as const, text: "No plan found" }] };
    const tasks = project.plan.tasks.map((t) => ({
      id: t.id,
      description: t.description.slice(0, 100),
      status: t.status,
      error: t.errorMessage,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] };
  },
};
