import { handleWritePlanningDocument } from "../../agents/planningTool.js";
import { config } from "../../config.js";

export const writePlanningDocumentTool = {
  name: "write_planning_document",
  description:
    'Write a planning document (spec or plan) to the project\'s planning branch. ' +
    'Call with type "spec" first to write the design spec and open the PR. ' +
    'Call with type "plan" after spec is approved. Returns the PR URL.',
  inputSchema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: ["spec", "plan"],
        description: 'Document type: "spec" for design spec, "plan" for implementation plan',
      },
      content: {
        type: "string",
        description: "Full Markdown content of the document",
      },
    },
    required: ["type", "content"],
  },
  async execute(
    args: { type: "spec" | "plan"; content: string },
    context: { projectId: string }
  ) {
    const result = await handleWritePlanningDocument(
      context.projectId,
      args.type,
      args.content,
      config.dataDir
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
};
