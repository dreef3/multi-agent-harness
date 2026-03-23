import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createGuardHook } from "./tools.mjs";

describe("createGuardHook", () => {
  const hook = createGuardHook();

  function run(command) {
    const result = hook({ command, cwd: "/tmp", env: {} });
    const blocked = result.command.includes("Blocked:");
    return { blocked, command: result.command };
  }

  // ── Allowed ──────────────────────────────────────────────────────────────────
  test("allows normal git push", () => assert.equal(run("git push origin main").blocked, false));
  test("allows git commit", () => assert.equal(run("git commit -m 'feat: x'").blocked, false));
  test("allows gh pr view", () => assert.equal(run("gh pr view 42").blocked, false));
  test("allows gh pr edit", () => assert.equal(run("gh pr edit 42 --title x").blocked, false));
  test("allows gh pr list", () => assert.equal(run("gh pr list").blocked, false));
  test("does not block echo of blocked string", () =>
    assert.equal(run("echo 'do not git push --force'").blocked, false));

  // ── Blocked: destructive git ──────────────────────────────────────────────────
  test("blocks git push --force", () => assert.equal(run("git push --force origin main").blocked, true));
  test("blocks git push -f", () => assert.equal(run("git push -f origin main").blocked, true));
  test("blocks git push --force-with-lease", () =>
    assert.equal(run("git push --force-with-lease origin main").blocked, true));
  test("blocks git push --delete", () => assert.equal(run("git push --delete origin branch").blocked, true));
  test("blocks git push -d", () => assert.equal(run("git push -d origin branch").blocked, true));
  test("blocks git push with embedded token", () =>
    assert.equal(run("git push https://x-access-token:ghp_abc@github.com/org/repo main").blocked, true));
  test("blocks git branch -D", () => assert.equal(run("git branch -D my-branch").blocked, true));
  test("blocks git branch --delete", () => assert.equal(run("git branch --delete my-branch").blocked, true));
  test("blocks git branch -d", () => assert.equal(run("git branch -d my-branch").blocked, true));

  // ── Blocked: destructive gh ───────────────────────────────────────────────────
  test("blocks gh repo delete", () => assert.equal(run("gh repo delete org/repo").blocked, true));
  test("blocks gh repo edit", () => assert.equal(run("gh repo edit --visibility private").blocked, true));
  test("blocks gh api", () => assert.equal(run("gh api repos/org/repo -X DELETE").blocked, true));

  // ── Blocked: network tools ────────────────────────────────────────────────────
  test("blocks curl", () => assert.equal(run("curl https://example.com").blocked, true));
  test("blocks wget", () => assert.equal(run("wget https://example.com").blocked, true));
  test("blocks http (httpie)", () => assert.equal(run("http GET https://example.com").blocked, true));

  // ── Extra patterns ────────────────────────────────────────────────────────────
  test("allows gh pr create when no extra patterns", () =>
    assert.equal(run("gh pr create --title x").blocked, false));
  test("blocks extra pattern when provided", () => {
    const hookWithExtra = createGuardHook([
      [["gh", "pr", "create"], "Use write_planning_document instead."],
    ]);
    assert.equal(hookWithExtra({ command: "gh pr create --title x", cwd: "/tmp", env: {} })
      .command.includes("Blocked:"), true);
  });
});

describe("createWebFetchTool (SSRF block)", async () => {
  // Import dynamically so guard tests run even if web_fetch has issues
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
  test("blocks 169.254.169.254 (metadata)", async () => {
    const r = await fetch_("http://169.254.169.254/latest/meta-data");
    assert.match(r.content[0].text, /Blocked/);
  });
  test("returns error for invalid URL", async () => {
    const r = await fetch_("not-a-url");
    assert.match(r.content[0].text, /invalid URL/i);
  });
});
