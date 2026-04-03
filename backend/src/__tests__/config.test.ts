import { describe, it, expect } from "vitest";
import { agentImage, resolveAgentConfig } from "../config.js";

describe("agentImage", () => {
  it("returns correct image name for each agent type", () => {
    expect(agentImage("pi")).toBe("multi-agent-harness/agent-pi:latest");
    expect(agentImage("gemini")).toBe("multi-agent-harness/agent-gemini:latest");
    expect(agentImage("copilot")).toBe("multi-agent-harness/agent-copilot:latest");
  });
});

describe("resolveAgentConfig", () => {
  it("returns project config when set", () => {
    const result = resolveAgentConfig(
      "planning",
      { type: "gemini", model: "gemini-2.5-pro" }
    );
    expect(result).toEqual({ type: "gemini", model: "gemini-2.5-pro", image: "multi-agent-harness/agent-gemini:latest" });
  });

  it("falls back to env defaults when project config is undefined", () => {
    const result = resolveAgentConfig("planning", undefined);
    expect(result.type).toBeTruthy();
    expect(result.model).toBeTruthy();
  });
});
