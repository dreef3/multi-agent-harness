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
  async execute(args: { tasks: Array<{ id?: string; repositoryId: string; description: string }> }, _context: { projectId: string }) {
    return { content: [{ type: "text" as const, text: `Acknowledged: ${args.tasks.length} task(s) queued for dispatch` }] };
  },
};
