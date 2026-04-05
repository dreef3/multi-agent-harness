import { describe, it, expect, vi } from "vitest";
import { AcpAgentManager } from "../orchestrator/acpAgentManager.js";
import { createServer, type Server, type Socket } from "net";

const mockDocker = {
  createContainer: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn().mockResolvedValue([]),
};

function createFakeAcpAgent(port: number): Promise<{ server: Server; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { id: number; method: string };
            if (msg.method === "initialize") {
              socket.write(JSON.stringify({
                jsonrpc: "2.0", id: msg.id,
                result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake" } },
              }) + "\n");
            } else if (msg.method === "session/new") {
              socket.write(JSON.stringify({
                jsonrpc: "2.0", id: msg.id,
                result: { sessionId: "test-session-123" },
              }) + "\n");
            }
          } catch {}
        }
      });
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, close: () => server.close() });
    });
  });
}

describe("AcpAgentManager", () => {
  it("performs ACP initialize + session/new handshake", async () => {
    const fakeAgent = await createFakeAcpAgent(13333);
    try {
      const manager = new AcpAgentManager(mockDocker as any);
      const state = await manager.connectAndInitialize("test-agent", "127.0.0.1", 13333);
      expect(state.acpInitialized).toBe(true);
      expect(state.acpSessionId).toBe("test-session-123");
    } finally {
      fakeAgent.close();
    }
  });
});
