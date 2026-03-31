/**
 * Implementation agent (sub-agent) isolation tests.
 *
 * Spins up the sub-agent Docker container with a no-op entrypoint (no LLM needed)
 * and verifies guard-hook behaviour and runner setup. Covers:
 *
 *   1. Guard hook — `gh pr create` is blocked; agent cannot create its own PRs
 *   2. Guard hook — embedded-token git push is blocked
 *   3. Runner setup — container checks out BRANCH_NAME on startup
 *
 * Run locally: bun test  (from this directory)
 * No COPILOT_GITHUB_TOKEN required — these tests are pure Docker.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";

// ── container lifecycle ───────────────────────────────────────────────────────

const CONTAINER_NAME = `impl-agent-test-${Date.now()}`;

beforeAll(() => {
  // Start a long-lived container using the sub-agent image but with a sleep
  // entrypoint so we can run docker exec commands without the runner exiting.
  execSync(
    `docker run -d --name ${CONTAINER_NAME} ` +
      `--entrypoint sleep ` +
      `multi-agent-harness/sub-agent:latest infinity`,
    { stdio: "pipe" }
  );
});

afterAll(() => {
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { stdio: "pipe" });
  } catch {
    /* already stopped */
  }
  try {
    execSync(`docker rm ${CONTAINER_NAME}`, { stdio: "pipe" });
  } catch {
    /* already removed */
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Run a Node.js ESM snippet inside the container and return its stdout. */
function nodeExec(snippet: string): string {
  // Pass the snippet via stdin to avoid shell escaping issues with JSON.stringify.
  // docker exec -i reads stdin; node --input-type=module reads ESM source from stdin.
  return execSync(`docker exec -i ${CONTAINER_NAME} node --input-type=module`, {
    input: snippet,
  }).toString();
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Implementation agent guard hook", () => {
  const importGuard = `
    import { createGuardHook } from '/app/tools.mjs';
    const hook = createGuardHook();
  `;

  test("gh pr create is blocked — harness handles PR creation", () => {
    const out = nodeExec(`
      ${importGuard}
      const r = hook({ command: 'gh pr create --title test --body ""', cwd: '/workspace', env: {} });
      process.stdout.write(r.command + '\\n');
    `);

    expect(out).toContain("Blocked:");
    expect(out).toContain("harness");
  });

  test("git push with embedded token URL is blocked", () => {
    const out = nodeExec(`
      ${importGuard}
      const r = hook({ command: 'git push https://x-access-token:abc123@github.com/org/repo.git HEAD:main', cwd: '/workspace', env: {} });
      process.stdout.write(r.command + '\\n');
    `);

    expect(out).toContain("Blocked:");
  });

  test("git push --force is blocked", () => {
    const out = nodeExec(`
      ${importGuard}
      const r = hook({ command: 'git push --force origin main', cwd: '/workspace', env: {} });
      process.stdout.write(r.command + '\\n');
    `);

    expect(out).toContain("Blocked:");
  });

  test("normal git commands are allowed through", () => {
    const out = nodeExec(`
      ${importGuard}
      const r = hook({ command: 'git status', cwd: '/workspace', env: {} });
      process.stdout.write(r.command + '\\n');
    `);

    // Should not be blocked — command passes through (possibly prefixed with rtk)
    expect(out).not.toContain("Blocked:");
    expect(out).toContain("git status");
  });
});
