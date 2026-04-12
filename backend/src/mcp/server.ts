import { Router, type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Token store ───────────────────────────────────────────────────────────────

export const validTokens = new Set<string>();

export function registerMcpToken(token: string): void {
  validTokens.add(token);
}

export function revokeMcpToken(token: string): void {
  validTokens.delete(token);
}

import { dispatchTasksTool } from "./tools/dispatch_tasks.js";
import { askPlanningAgentTool } from "./tools/ask_planning_agent.js";
import { writePlanningDocumentTool } from "./tools/write_planning_document.js";
import { getTaskStatusTool } from "./tools/get_task_status.js";
import { getPullRequestsTool } from "./tools/get_pull_requests.js";
import { replyToSubagentTool } from "./tools/reply_to_subagent.js";
import { webFetchTool } from "./tools/web_fetch.js";
import { getBuildStatusTool } from "./tools/get_build_status.js";
import { getBuildLogsTool } from "./tools/get_build_logs.js";

// ── Tool type ─────────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  execute: (
    args: Record<string, unknown>,
    context: { projectId: string; sessionId?: string; role?: string }
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

interface McpContext {
  projectId: string;
  sessionId: string;
  role: string;
}

// ── Tool sets ─────────────────────────────────────────────────────────────────

const PLANNING_TOOLS: McpTool[] = [
  dispatchTasksTool,
  writePlanningDocumentTool,
  getTaskStatusTool,
  getPullRequestsTool,
  replyToSubagentTool,
  webFetchTool,
  getBuildStatusTool,
  getBuildLogsTool,
];

const IMPL_TOOLS: McpTool[] = [
  askPlanningAgentTool,
  webFetchTool,
];

// ── Factory ───────────────────────────────────────────────────────────────────

function buildServer(tools: McpTool[], context: McpContext): Server {
  const server = new Server(
    { name: "harness", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    try {
      return await tool.execute(args, context);
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Tool error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Express middleware ────────────────────────────────────────────────────────

export function createMcpMiddleware(): Router {
  const router = Router();
  const transports = new Map<string, SSEServerTransport>();

  // GET /mcp — establish SSE stream
  router.get("/", async (req: Request, res: Response) => {
    const token = req.query.token as string | undefined;
    if (!token || !validTokens.has(token)) {
      res.status(401).json({ error: "Unauthorized: missing or invalid MCP token" });
      return;
    }

    const projectId = (req.query.projectId as string) ?? "";
    const sessionId = (req.query.sessionId as string) ?? crypto.randomUUID();
    const role = (req.query.role as string) ?? "planning";
    const context: McpContext = { projectId, sessionId, role };

    const tools = role === "implementation" ? IMPL_TOOLS : PLANNING_TOOLS;
    const server = buildServer(tools, context);

    const transport = new SSEServerTransport("/mcp/messages", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  });

  // POST /mcp/messages — client→server messages
  router.post("/messages", async (req: Request, res: Response) => {
    const sessionId = (req.query.sessionId as string) ?? "";
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  return router;
}
