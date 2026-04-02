import { describe, it, expect } from "vitest";
import { buildCiToolsDescription } from "../ciTools.js";

describe("buildCiToolsDescription", () => {
  it("includes the correct API URL in tool descriptions", () => {
    const desc = buildCiToolsDescription("https://harness.corp.example.com");
    expect(desc).toContain("https://harness.corp.example.com/api/pull-requests/{pullRequestId}/build-status");
    expect(desc).toContain("https://harness.corp.example.com/api/pull-requests/{pullRequestId}/build-logs/{buildId}");
  });

  it("includes polling workflow guidance", () => {
    const desc = buildCiToolsDescription("http://localhost:3000");
    expect(desc).toContain('state == "pending"');
    expect(desc).toContain('state == "failure"');
    expect(desc).toContain('state == "success"');
  });

  it("does not hardcode a specific URL", () => {
    const desc1 = buildCiToolsDescription("http://localhost:3000");
    const desc2 = buildCiToolsDescription("https://prod.example.com");
    expect(desc1).not.toContain("prod.example.com");
    expect(desc2).not.toContain("localhost:3000");
  });
});
