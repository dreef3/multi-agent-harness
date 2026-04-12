/**
 * Tests that write_planning_document works end-to-end:
 *   1. Extension file is present and loads cleanly in the container (pure Docker, no LLM)
 *   2. After being asked to call the tool, the agent calls it and the mock backend
 *      records the call (LLM required — skipped if COPILOT_GITHUB_TOKEN not set)
 *   3. Agent does NOT run edit/write tools when given a planning request (Phase 1 gate)
 *
 * Requires: COPILOT_GITHUB_TOKEN (or GH_TOKEN) for LLM tests.
 * A mock HTTP server is started in-process and exposed to the container via
 * host.docker.internal (--add-host=host.docker.internal:host-gateway).
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

interface MockRequest { path: string; body: Record<string, unknown> }

function startMockBackend(): Promise<{ server: Server; port: number; requests: MockRequest[] }> {
  const requests: MockRequest[] = [];

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        requests.push({ path: req.url ?? "", body });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prUrl: "https://github.com/test-org/test-repo/pull/42" }));
      });
    });
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, requests });
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

describe("write_planning_document tool (planning agent)", () => {
  let client: AcpTestClient;
  let mockServer: Server;
  let mockPort: number;
  let mockRequests: MockRequest[];

  const TEST_TOKEN = "e2e-test-mcp-token";

  // ── Test 1: pure Docker — no LLM ─────────────────────────────────────────────

  test("harness-planning-tools.mjs loads in container without errors", () => {
    const containerName = `agent-test-ext-check-${Date.now()}`;
    const image = `multi-agent-harness/agent-${AGENT_TYPE}:latest`;

    try {
      execSync(
        `docker run -d --name ${containerName} -e COPILOT_GITHUB_TOKEN=dummy ${image}`,
        { stdio: "pipe" }
      );

      const output = execSync(
        `docker exec ${containerName} node --input-type=module -e ` +
        `"import('/app/harness-planning-tools.mjs').then(() => console.log('OK'))"`
      ).toString().trim();

      expect(output).toBe("OK");
    } finally {
      try { execSync(`docker rm -f ${containerName}`, { stdio: "pipe" }); } catch {}
    }
  });

  // ── Tests 2–3: LLM required ────────────────────────────────────────────────

  beforeAll(async () => {
    if (!COPILOT_TOKEN) return;

    const mock = await startMockBackend();
    mockServer   = mock.server;
    mockPort     = mock.port;
    mockRequests = mock.requests;

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
    "agent calls write_planning_document when asked and mock backend records the request",
    async () => {
      if (!COPILOT_TOKEN) {
        console.log("Skipping LLM test — COPILOT_GITHUB_TOKEN not set");
        return;
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

      // Mock backend must have received the POST request
      const wpd = mockRequests.find((r) => r.path === "/api/tools/write-planning-document");
      expect(wpd).toBeDefined();
      expect(wpd!.body.type).toBe("spec");
      expect(typeof wpd!.body.content).toBe("string");
      expect((wpd!.body.content as string).length).toBeGreaterThan(10);

      // Agent should mention the mock PR URL returned by the server
      expect(text).toContain("pull/42");
    },
    PROMPT_TIMEOUT + 10_000
  );

  test(
    "agent does NOT run edit or write tools when given a fresh planning request",
    async () => {
      if (!COPILOT_TOKEN) {
        console.log("Skipping LLM test — COPILOT_GITHUB_TOKEN not set");
        return;
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
