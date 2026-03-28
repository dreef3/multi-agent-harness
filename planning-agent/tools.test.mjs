import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPlanningAgentGuardHook } from "./tools.mjs";

describe("createPlanningAgentGuardHook", () => {
  const hook = createPlanningAgentGuardHook();

  function blocked(command) {
    return hook({ command, cwd: "/tmp", env: {} }).command.includes("Blocked:");
  }

  // Inherits all base blocks
  test("blocks git push --force", () => assert.equal(blocked("git push --force"), true));
  test("blocks curl", () => assert.equal(blocked("curl https://x.com"), true));
  test("blocks gh api", () => assert.equal(blocked("gh api repos/x -X DELETE"), true));

  // Planning-agent-specific block
  test("blocks gh pr create", () => assert.equal(blocked("gh pr create --title x"), true));
  test("gh pr create block message mentions write_planning_document", () => {
    const result = hook({ command: "gh pr create --title x", cwd: "/tmp", env: {} });
    assert.match(result.command, /write_planning_document/);
  });

  // gh pr edit is allowed
  test("allows gh pr edit", () => assert.equal(blocked("gh pr edit 42 --title x"), false));
  test("allows gh pr list", () => assert.equal(blocked("gh pr list"), false));
  test("allows normal git push", () => assert.equal(blocked("git push origin main"), false));
});

describe("createPlanningAgentGuardHook — .harness/ path guard", () => {
  const hook = createPlanningAgentGuardHook();

  function blocked(command) {
    return hook({ command, cwd: "/tmp", env: {} }).command.includes("exit 1");
  }

  test("blocks direct .harness/ path in command", () =>
    assert.equal(blocked("cat .harness/trace.json"), true));

  test("block message contains GUARD", () => {
    const result = hook({ command: "ls .harness/", cwd: "/tmp", env: {} });
    assert.match(result.command, /GUARD/);
  });

  test("blocks absolute path containing .harness/", () =>
    assert.equal(blocked("rm -rf /workspace/.harness/logs/"), true));

  test("does not block unrelated commands", () =>
    assert.equal(blocked("git status"), false));
});

describe("createWebFetchTool (SSRF block)", async () => {
  const { createWebFetchTool } = await import("./tools.mjs");
  const tool = createWebFetchTool();

  async function fetch_(url) {
    return tool.execute("id", { url });
  }

  test("blocks localhost", async () => {
    const r = await fetch_("http://localhost/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 127.0.0.1", async () => {
    const r = await fetch_("http://127.0.0.1/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 10.x range", async () => {
    const r = await fetch_("http://10.0.0.1/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 172.16.x range", async () => {
    const r = await fetch_("http://172.16.0.1/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 192.168.x range", async () => {
    const r = await fetch_("http://192.168.1.1/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 169.254.169.254 (metadata)", async () => {
    const r = await fetch_("http://169.254.169.254/latest/meta-data");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks IPv6 loopback [::1]", async () => {
    const r = await fetch_("http://[::1]/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("blocks 0.0.0.0", async () => {
    const r = await fetch_("http://0.0.0.0/foo");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("returns error for invalid URL", async () => {
    const r = await fetch_("not-a-url");
    assert.match(r.content[0].text, /invalid URL/i);
  });
});
