/**
 * Planning agent isolation tests (ACP protocol).
 *
 * Spins up an agent Docker container directly (no full harness stack)
 * and tests it via the ACP TCP interface. Covers:
 *
 *   1. Container bootstrap — starts, TCP connects, ACP session initializes
 *   2. Skill file access  — agent reads brainstorming SKILL.md via `cat` (absolute path)
 *   3. Phase-1 behaviour  — agent asks clarifying questions, not immediately writing a spec
 *   4. Guard hook         — `gh pr create` is blocked; agent is told to use write_planning_document
 *
 * Run locally: bun test  (from this directory)
 * Required env: COPILOT_GITHUB_TOKEN (or GH_TOKEN) with a GitHub Copilot subscription.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { AcpTestClient, type AcpEvent } from "./rpc-client";

// ── config ────────────────────────────────────────────────────────────────────

const COPILOT_TOKEN =
  process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const AGENT_TYPE = process.env.AGENT_TYPE ?? "copilot";
const PROVIDER = process.env.AGENT_PROVIDER ?? "github-copilot";
const MODEL = process.env.AGENT_MODEL ?? "gpt-5-mini";

// Time budget for each phase (generous to accommodate slow models on CI)
const CONTAINER_START_TIMEOUT = 120_000; // 2 min — clone + session init
const PROMPT_TIMEOUT = 90_000; // 1.5 min per prompt

// ── helpers ───────────────────────────────────────────────────────────────────

/** Extract text content from session/update notification params. */
function responseText(events: AcpEvent[]): string {
  return events
    .filter((e) => e.method === "session/update")
    .flatMap((e) => {
      const content = e.params?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((c: unknown) => (c as { type?: string }).type === "text")
        .map((c: unknown) => (c as { text?: string }).text ?? "");
    })
    .join("");
}

/** Names of tools invoked during ACP session updates. */
function toolNames(events: AcpEvent[]): string[] {
  return events
    .filter((e) => e.method === "session/update")
    .flatMap((e) => {
      const content = e.params?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((c: unknown) => (c as { type?: string }).type === "tool_use")
        .map((c: unknown) => String((c as { name?: string }).name ?? ""));
    });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("Planning agent (ACP isolation)", () => {
  let client: AcpTestClient;

  beforeAll(async () => {
    if (!COPILOT_TOKEN) {
      throw new Error(
        "COPILOT_GITHUB_TOKEN or GH_TOKEN must be set to run planning-agent tests"
      );
    }

    client = new AcpTestClient({
      projectId: `test-${Date.now()}`,
      agentType: AGENT_TYPE,
      provider: PROVIDER,
      model: MODEL,
      env: [`COPILOT_GITHUB_TOKEN=${COPILOT_TOKEN}`],
      // Backend URL is intentionally unreachable for Phase-1 tests
      // (write_planning_document / dispatch_tasks are not called until after LGTM)
      backendUrl: "http://localhost:19999",
    });

    await client.start(CONTAINER_START_TIMEOUT);
  }, CONTAINER_START_TIMEOUT + 10_000);

  afterAll(async () => {
    await client.stop();
  });

  // ── Test 1: skill file accessible ──────────────────────────────────────────

  test("brainstorming SKILL.md is readable at /app/node_modules path", () => {
    // Pure Docker test — no LLM involved.
    // Verifies the fix: `cat /app/...` works (absolute path in bash),
    // while `read /app/...` would silently become /workspace/app/... and fail.
    const output = execSync(
      `docker exec ${client.containerName} cat /app/node_modules/superpowers/skills/brainstorming/SKILL.md`
    )
      .toString()
      .trim();

    expect(output).toContain("brainstorming");
    expect(output.length).toBeGreaterThan(100);
  });

  test("writing-plans SKILL.md is readable at /app/node_modules path", () => {
    const output = execSync(
      `docker exec ${client.containerName} cat /app/node_modules/superpowers/skills/writing-plans/SKILL.md`
    )
      .toString()
      .trim();

    expect(output).toContain("plan");
    expect(output.length).toBeGreaterThan(100);
  });

  // ── Test 2: Phase-1 behaviour ───────────────────────────────────────────────

  test(
    "agent reads brainstorming skill via bash and asks clarifying questions",
    async () => {
      const events = await client.sendPrompt(
        "Add a dark mode toggle button to the main navigation bar",
        PROMPT_TIMEOUT
      );

      // Must have received a session/prompt response (not just timed out mid-stream)
      const hasResponse = events.some((e) => e.result != null);
      expect(hasResponse).toBe(true);

      // Agent must produce text output via session/update notifications
      const text = responseText(events);
      expect(text.length).toBeGreaterThan(20);

      // Phase 1: agent asks clarifying questions, does NOT immediately write a spec
      // (write_planning_document and dispatch_tasks are Phase-2/3 tools)
      const tools = toolNames(events);
      expect(tools).not.toContain("write_planning_document");
      expect(tools).not.toContain("dispatch_tasks");

      // Response should contain at least one question (brainstorming skill HARD-GATE)
      expect(text).toMatch(/\?/);
    },
    PROMPT_TIMEOUT + 10_000
  );

  // ── Test 3: Guard hook ──────────────────────────────────────────────────────

  test(
    "gh pr create is blocked by guard hook and agent is told to use write_planning_document",
    async () => {
      // Verify the guard hook blocks `gh pr create` via a direct exec in the container.
      const hookOutput = execSync(
        `docker exec ${client.containerName} node -e "
          import('/app/tools.mjs').then(m => {
            const hook = m.createPlanningAgentGuardHook();
            const result = hook({ command: 'gh pr create --title test', cwd: '/workspace', env: {} });
            console.log(result.command);
          });
        "`
      ).toString();

      expect(hookOutput).toContain("Blocked:");
      expect(hookOutput).toContain("write_planning_document");
    }
  );

  // ── Test 4: agent responds to follow-up after first turn ───────────────────

  test(
    "agent responds to follow-up prompt in the same session",
    async () => {
      const events = await client.sendPrompt(
        "Actually, just confirm you understand the task and are ready to proceed",
        PROMPT_TIMEOUT
      );

      const hasResponse = events.some((e) => e.result != null);
      expect(hasResponse).toBe(true);

      const text = responseText(events);
      expect(text.length).toBeGreaterThan(10);
    },
    PROMPT_TIMEOUT + 10_000
  );
});
