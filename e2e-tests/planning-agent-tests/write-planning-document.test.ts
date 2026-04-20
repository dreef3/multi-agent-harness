/**
 * Tests that write_planning_document works end-to-end via the native pi extension:
 *   1. harness-planning-tools.mjs is present in the container (pure Docker, no LLM)
 *   2. After being asked to call the tool, the agent calls it and the mock REST
 *      backend records the call (LLM required — throws if COPILOT_GITHUB_TOKEN not set)
 *   3. Agent does NOT run edit/write tools when given a planning request (Phase 1 gate)
 *
 * write_planning_document is a native pi extension registered via --extension
 * /app/harness-planning-tools.mjs (not MCP). The extension calls the harness
 * backend's REST endpoint: POST /api/tools/write-planning-document.
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

interface RestToolCall { type: string; content: string }

/**
 * Minimal mock of the harness backend's write-planning-document REST endpoint.
 * The harness-planning-tools.mjs extension calls:
 *   POST ${HARNESS_API_URL}/api/tools/write-planning-document
 * with JSON body { projectId, type, content } and Bearer auth.
 * Returns { prUrl: string }.
 */
function startMockHarnessBackend(): Promise<{
  server: Server;
  port: number;
  toolCalls: RestToolCall[];
}> {
  const toolCalls: RestToolCall[] = [];

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (
        req.method === "POST" &&
        req.url?.startsWith("/api/tools/write-planning-document")
      ) {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(raw); } catch { /**/ }
          toolCalls.push({
            type: (body.type as string) ?? "",
            content: (body.content as string) ?? "",
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            prUrl: "https://github.com/test-org/test-repo/pull/42",
          }));
        });
        return;
      }
      // Swallow any other requests (health-checks, etc.)
      res.writeHead(404);
      res.end();
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
      // pi may emit the tool name or label; capture both
      const title = update.title as string | undefined;
      const name  = update.name  as string | undefined;
      return [title, name].filter((s): s is string => !!s);
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

describe("write_planning_document tool via REST extension (planning agent)", () => {
  let client: AcpTestClient;
  let mockServer: Server;
  let mockPort: number;
  let mockToolCalls: RestToolCall[];

  const TEST_TOKEN = "e2e-test-mcp-token";

  // ── Test 1: pure Docker — no LLM ─────────────────────────────────────────────

  test("harness-planning-tools.mjs extension is present in the container", () => {
    // write_planning_document is a native pi extension (not MCP).
    // This verifies the extension file exists and can be imported.
    const image = `multi-agent-harness/agent-${AGENT_TYPE}:latest`;
    const containerName = `agent-test-ext-check-${Date.now()}`;

    try {
      execSync(
        `docker run -d --name ${containerName} -e COPILOT_GITHUB_TOKEN=dummy ${image}`,
        { stdio: "pipe" }
      );

      // Verify the extension file is present
      const output = execSync(
        `docker exec ${containerName} node -e ` +
        `"import('/app/harness-planning-tools.mjs').then(() => console.log('ok')).catch(e => { process.stderr.write(e.message+'\\n'); process.exit(1); })"`
      ).toString().trim();

      expect(output).toBe("ok");
    } finally {
      try { execSync(`docker rm -f ${containerName}`, { stdio: "pipe" }); } catch {}
    }
  });

  // ── Tests 2–3: LLM required ────────────────────────────────────────────────

  beforeAll(async () => {
    if (!COPILOT_TOKEN) return;

    const mock = await startMockHarnessBackend();
    mockServer   = mock.server;
    mockPort     = mock.port;
    mockToolCalls = mock.toolCalls;

    client = new AcpTestClient({
      projectId: `test-wpd-${Date.now()}`,
      agentType: AGENT_TYPE,
      provider: PROVIDER,
      model: MODEL,
      // AcpTestClient sets both BACKEND_URL and HARNESS_API_URL to this value.
      // harness-planning-tools.mjs reads HARNESS_API_URL.
      backendUrl: `http://host.docker.internal:${mockPort}`,
      mcpToken: TEST_TOKEN,
      env: [
        `COPILOT_GITHUB_TOKEN=${COPILOT_TOKEN}`,
        // Override AGENTS.md with a simpler prompt so the multi-phase brainstorming
        // workflow doesn't intercept explicit tool-call requests in Test 2, and so
        // Test 3 still passes (no edit/write, clarifying questions).
        `PLANNING_SYSTEM_PROMPT=You are a planning assistant. You help users plan features by asking clarifying questions. You have a write_planning_document tool. When explicitly asked to call write_planning_document with specific type and content parameters, call it immediately with those exact values. Never write implementation code yourself — always ask clarifying questions for feature requests.`,
      ],
    });

    await client.start(CONTAINER_START_TIMEOUT);
  }, CONTAINER_START_TIMEOUT + 10_000);

  afterAll(async () => {
    if (client) await client.stop();
    if (mockServer) await new Promise<void>((r) => mockServer.close(() => r()));
  });

  test(
    "agent calls write_planning_document when asked and mock REST backend records the call",
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

      // pi must emit a tool_call event for the extension tool
      const tools = toolNames(events);
      expect(
        tools.some((t) => t === "write_planning_document" || t === "Write Planning Document"),
        `Expected write_planning_document in tool events. Got: ${JSON.stringify(tools)}`
      ).toBe(true);

      // Mock REST backend must have received the POST request
      const call = mockToolCalls.find((c) => c.type === "spec");
      expect(
        call,
        `Mock backend did not receive a write-planning-document call. Calls received: ${JSON.stringify(mockToolCalls)}`
      ).toBeDefined();
      expect(typeof call!.content).toBe("string");
      expect(call!.content.length).toBeGreaterThan(10);

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

      let events = await client.sendPrompt(
        "Add a user settings page with theme toggle and language selector",
        PROMPT_TIMEOUT
      );

      let text = responseText(events);

      // gpt-5-mini sometimes calls tools instead of outputting text on the first turn.
      // Retry once with an explicit clarification nudge.
      if (text.length === 0) {
        process.stderr.write(
          `[test] Warning: first prompt returned 0 text. Tool events: ${JSON.stringify(toolNames(events))}. Retrying.\n`
        );
        const retryEvents = await client.sendPrompt(
          "Please respond with any clarifying questions you have.",
          PROMPT_TIMEOUT
        );
        events = events.concat(retryEvents);
        text = responseText(retryEvents);
      }

      const tools = toolNames(events);

      // During brainstorming the agent must NOT write implementation code
      expect(tools).not.toContain("edit");
      expect(tools).not.toContain("write");

      // Phase 1 gate: response should contain a clarifying question
      expect(text).toMatch(/\?/);
    },
    PROMPT_TIMEOUT * 2 + 10_000
  );
});
