export const dispatchTasksTool = {
  name: "dispatch_tasks",
  description: "Dispatch implementation tasks to sub-agents",
  inputSchema: {
    type: "object" as const,
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            repositoryId: { type: "string" },
            description: { type: "string" },
          },
          required: ["repositoryId", "description"],
        },
      },
    },
    required: ["tasks"],
  },
  async execute(args: Record<string, unknown>, _context: { projectId: string; sessionId?: string; role?: string }) {
    const tasks = args.tasks as Array<{ id?: string; repositoryId: string; description: string }>;
    return { content: [{ type: "text" as const, text: `Acknowledged: ${tasks.length} task(s) queued for dispatch` }] };
  },
};
