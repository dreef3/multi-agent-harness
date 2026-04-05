import { describe, it, expect } from "bun:test";
import { spawn } from "child_process";
import { createConnection } from "net";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("stdio-tcp-bridge", () => {
  it("pipes TCP input to subprocess stdin and subprocess stdout to TCP", async () => {
    // Use `cat` as a simple echo subprocess
    const bridge = spawn("node", [
      "agents/stdio-tcp-bridge.mjs",
      "cat",
    ], { stdio: ["pipe", "pipe", "inherit"], cwd: "/home/ae/multi-agent-harness" });

    await sleep(500); // wait for server to bind

    const received = await new Promise((resolve, reject) => {
      const socket = createConnection(3333, "127.0.0.1", () => {
        socket.write("hello\n");
      });
      socket.on("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(received).toBe("hello\n");
    bridge.kill();
  });
});
