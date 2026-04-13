/**
 * Tests that write_planning_document works end-to-end via MCP:
 *   1. pi-mcp-adapter is installed in the container (pure Docker, no LLM)
 *   2. After being asked to call the tool, the agent calls it and the mock MCP
 *      backend records the call (LLM required — skipped if COPILOT_GITHUB_TOKEN not set)
 *   3. Agent does NOT run edit/write tools when given a planning request (Phase 1 gate)
 *
 * The mock MCP backend implements a minimal Streamable HTTP MCP server so that
 * pi-mcp-adapter can connect, discover write_planning_document, and call it.
 *
 * Requires: COPILOT_GITHUB_TOKEN (or GH_TOKEN) for LLM tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { createServer } from "http";
import type { Server, IncomingMessage, ServerResponse } from "http";
import { AcpTestClient, type AcpEvent } from "./rpc-client";

// ── config ─────────────────────────────────────────────────────────────────────

const COPILOT_TOKEN =
  process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const AGENT_TYPE = process.env.AGENT_TYPE ?? "pi";
const PROVIDER   = process.env.AGENT_PROVIDER ?? "github-copilot";
const MODEL      = process.env.AGENT_MODEL ?? "gpt-5-mini";

const CONTAINER_START_TIMEOUT = 120_000;
const PROMPT_TIMEOUT          =  90_000;

// ── helpers ────────────────────────────────────────────────────────────────────

interface McpToolCall { name: string; arguments: Record<string, unknown> }

/**
 * Minimal Streamable HTTP MCP server.
 * pi-mcp-adapter tries StreamableHTTP first; this mock handles the JSON-RPC
 * over POST so the agent can discover and call write_planning_document.
 */
function startMockMcpBackend(): Promise<{
  server: Server;
  port: number;
  toolCalls: McpToolCall[];
}> {
  const toolCalls: McpToolCall[] = [];

  const WRITE_PLANNING_TOOL = {
    name: "write_planning_document",
    description:
      'Write a planning document (spec or plan). Call with type "spec" then "plan".',
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["spec", "plan"] },
        content: { type: "string" },
      },
      required: ["type", "content"],
    },
  };

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let msg: Record<string, unknown> = {};
        try { msg = raw ? JSON.parse(raw) : {}; } catch { /**/ }

        const { method, id } = msg as { method?: string; id?: unknown };
        let result: Record<string, unknown>;

        if (method === "initialize") {
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-harness", version: "1.0.0" },
          };
        } else if (method === "tools/list") {
          result = { tools: [WRITE_PLANNING_TOOL] };
        } else if (method === "tools/call") {
          const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          toolCalls.push({ name: params.name ?? "", arguments: params.arguments ?? {} });
          result = {
            content: [{
              type: "text",
              text: "Planning document created. PR: https://github.com/test-org/test-repo/pull/42",
            }],
          };
        } else {
          result = {};
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });

    server.listen(0, "0.0.0.0", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, toolCalls });
    });
  });
}

function toolNames(events: AcpEvent[]): string[] {
  return events
    .filter((e) => e.method === "session/update")
    .flatMap((e) => {
      const update = e.params?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate !== "tool_call") return [];
      const title = update.title as string | undefined;
      return title ? [title] : [];
    });
}

function responseText(events: AcpEvent[]): string {
  return events
    .filter((e) => e.method === "session/update")
    .flatMap((e) => {
      const update = e.params?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate !== "agent_message_chunk") return [];
      const content = update.content as { type?: string; text?: string } | undefined;
      if (!content || content.type !== "text") return [];
      return [content.text ?? ""];
    })
    .join("");
}

// ── suite ──────────────────────────────────────────────────────────────────────

describe("write_planning_document tool via MCP (planning agent)", () => {
  let client: AcpTestClient;
  let mockServer: Server;
  let mockPort: number;
  let mockToolCalls: McpToolCall[];

  const TEST_TOKEN = "e2e-test-mcp-token";

  // ── Test 1: pure Docker — no LLM ─────────────────────────────────────────────

  test("pi-mcp-adapter is installed in the container", () => {
    const containerName = `agent-test-ext-check-${Date.now()}`;
    const image = `multi-agent-harness/agent-${AGENT_TYPE}:latest`;

    try {
      execSync(
        `docker run -d --name ${containerName} -e COPILOT_GITHUB_TOKEN=dummy ${image}`,
        { stdio: "pipe" }
      );

      // Verify pi-mcp-adapter package is present
      const output = execSync(
        `docker exec ${containerName} node -e ` +
        `"const p=require('/app/node_modules/pi-mcp-adapter/package.json');console.log(p.name)"`
      ).toString().trim();

      expect(output).toBe("pi-mcp-adapter");
    } finally {
      try { execSync(`docker rm -f ${containerName}`, { stdio: "pipe" }); } catch {}
    }
  });

  // ── Tests 2–3: LLM required ────────────────────────────────────────────────

  beforeAll(async () => {
    if (!COPILOT_TOKEN) return;

    const mock = await startMockMcpBackend();
    mockServer   = mock.server;
    mockPort     = mock.port;
    mockToolCalls = mock.toolCalls;

    client = new AcpTestClient({
      projectId: `test-wpd-${Date.now()}`,
      agentType: AGENT_TYPE,
      provider: PROVIDER,
      model: MODEL,
      backendUrl: `http://host.docker.internal:${mockPort}`,
      mcpToken: TEST_TOKEN,
      env: [`COPILOT_GITHUB_TOKEN=${COPILOT_TOKEN}`],
    });

    await client.start(CONTAINER_START_TIMEOUT);
  }, CONTAINER_START_TIMEOUT + 10_000);

  afterAll(async () => {
    if (client) await client.stop();
    if (mockServer) await new Promise<void>((r) => mockServer.close(() => r()));
  });

  test(
    "agent calls write_planning_document when asked and mock MCP backend records the call",
    async () => {
      if (!COPILOT_TOKEN) {
        throw new Error(
          "COPILOT_GITHUB_TOKEN or GH_TOKEN is required for this LLM test. " +
          "Set it to run, or the test must not silently pass."
        );
      }

      const events = await client.sendPrompt(
        `Please call the write_planning_document tool with type="spec" and ` +
        `content="# Test Spec\n## Overview\nThis is a test planning document."`,
        PROMPT_TIMEOUT
      );

      const text = responseText(events);
      expect(text.length).toBeGreaterThan(10);

      const tools = toolNames(events);
      expect(tools).toContain("write_planning_document");

      // Mock MCP backend must have received the tools/call request
      const call = mockToolCalls.find((c) => c.name === "write_planning_document");
      expect(call).toBeDefined();
      expect(call!.arguments.type).toBe("spec");
      expect(typeof call!.arguments.content).toBe("string");
      expect((call!.arguments.content as string).length).toBeGreaterThan(10);

      // Agent should mention the PR URL returned by the mock
      expect(text).toContain("pull/42");
    },
    PROMPT_TIMEOUT + 10_000
  );

  test(
    "agent does NOT run edit or write tools when given a fresh planning request",
    async () => {
      if (!COPILOT_TOKEN) {
        throw new Error(
          "COPILOT_GITHUB_TOKEN or GH_TOKEN is required for this LLM test. " +
          "Set it to run, or the test must not silently pass."
        );
      }

      const events = await client.sendPrompt(
        "Add a user settings page with theme toggle and language selector",
        PROMPT_TIMEOUT
      );

      const tools = toolNames(events);

      // During brainstorming the agent must NOT write implementation code
      expect(tools).not.toContain("edit");
      expect(tools).not.toContain("write");

      // Phase 1 gate: response should contain a clarifying question
      const text = responseText(events);
      expect(text).toMatch(/\?/);
    },
    PROMPT_TIMEOUT + 10_000
  );
});
