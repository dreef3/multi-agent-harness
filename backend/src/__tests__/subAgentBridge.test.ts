import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "stream";
import { SubAgentBridge } from "../agents/subAgentBridge.js";

function makeDockerMock(stream: PassThrough) {
  return { getContainer: vi.fn().mockReturnValue({ attach: vi.fn().mockResolvedValue(stream) }) };
}

describe("SubAgentBridge", () => {
  it("emits parsed JSON-RPC messages", async () => {
    const stream = new PassThrough();
    const bridge = new SubAgentBridge();
    await bridge.attach(makeDockerMock(stream) as never, "container-abc");
    const messages: unknown[] = [];
    bridge.on("message", (msg) => messages.push(msg));
    stream.push('{"type":"session/update","content":"hello"}\n');
    stream.push('{"type":"session/update","content":"world"}\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "session/update", content: "hello" });
  });

  it("emits raw 'output' event for non-JSON lines", async () => {
    const stream = new PassThrough();
    const bridge = new SubAgentBridge();
    await bridge.attach(makeDockerMock(stream) as never, "container-abc");
    const outputs: string[] = [];
    bridge.on("output", (line: string) => outputs.push(line));
    stream.push("Starting Maven build...\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(outputs).toContain("Starting Maven build...");
  });

  it("writes JSON-RPC messages to container stdin", async () => {
    const stream = new PassThrough();
    const bridge = new SubAgentBridge();
    await bridge.attach(makeDockerMock(stream) as never, "container-abc");
    const written: string[] = [];
    stream.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    bridge.send({ type: "session/prompt", text: "do the task" });
    await new Promise((r) => setTimeout(r, 10));
    const all = written.join("");
    expect(all).toContain('"type":"session/prompt"');
    expect(all.endsWith("\n")).toBe(true);
  });

  it("throws if send is called before attach", () => {
    const bridge = new SubAgentBridge();
    expect(() => bridge.send({ type: "test" })).toThrow("not attached");
  });
});
