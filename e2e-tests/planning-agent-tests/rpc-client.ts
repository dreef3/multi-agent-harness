/**
 * Minimal TCP RPC client for the planning agent.
 * Connects to the agent's TCP server on port 3333 and exchanges newline-delimited JSON.
 */
import { createConnection, Socket } from "net";
import { execSync } from "child_process";
import { mkdtempSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface RpcEvent {
  type: string;
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
  assistantMessageEvent?: { type: string; delta?: string };
  message?: { role?: string; stopReason?: string };
  [key: string]: unknown;
}

export class PlanningAgentRpcClient {
  private socket: Socket | null = null;
  private lineBuffer = "";
  readonly containerName: string;
  readonly piAgentDir: string;

  constructor(
    private readonly options: {
      projectId: string;
      provider?: string;
      model?: string;
      copilotToken?: string;
      backendUrl?: string;
    }
  ) {
    this.containerName = `planning-agent-test-${options.projectId}`;
    this.piAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-test-"));
    chmodSync(this.piAgentDir, 0o777);
  }

  /** Start the container and wait for the TCP RPC server to be ready. */
  async start(connectTimeoutMs = 120_000): Promise<void> {
    const envFlags = [
      `-e PROJECT_ID=${this.options.projectId}`,
      `-e GIT_CLONE_URLS=[]`,
      `-e BACKEND_URL=${this.options.backendUrl ?? "http://localhost:19999"}`,
      `-e AGENT_PROVIDER=${this.options.provider ?? "github-copilot"}`,
      `-e AGENT_MODEL=${this.options.model ?? "gpt-5-mini"}`,
      ...(this.options.copilotToken
        ? [`-e COPILOT_GITHUB_TOKEN=${this.options.copilotToken}`]
        : []),
    ].join(" ");

    execSync(
      `docker run -d --name ${this.containerName} ${envFlags} ` +
        `-v ${this.piAgentDir}:/pi-agent ` +
        `multi-agent-harness/planning-agent:latest`,
      { stdio: "pipe" }
    );

    // Get container IP on its Docker bridge network
    const ip = execSync(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${this.containerName}`
    )
      .toString()
      .trim();

    // Wait for port 3333 to open (agent clones repos + initialises session first)
    await waitForPort(ip, 3333, connectTimeoutMs);

    // Connect the RPC socket
    this.socket = await tcpConnect(ip, 3333);
  }

  /** Send a prompt and collect all events until agent_end, or until timeout. */
  async sendPrompt(message: string, timeoutMs = 90_000): Promise<RpcEvent[]> {
    if (!this.socket) throw new Error("Not connected — call start() first");

    const events: RpcEvent[] = [];
    const isStreaming = events.some((e) => e.type === "agent_start");

    this.socket.write(
      JSON.stringify({
        type: "prompt",
        message,
        ...(isStreaming ? { streamingBehavior: "followUp" } : {}),
      }) + "\n"
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(events);
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        this.lineBuffer += chunk.toString();
        const lines = this.lineBuffer.split("\n");
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as RpcEvent;
            events.push(event);
            if (event.type === "agent_end") {
              clearTimeout(timer);
              cleanup();
              resolve(events);
            }
          } catch {
            // ignore malformed lines
          }
        }
      };

      const cleanup = () => this.socket?.off("data", onData);
      this.socket!.on("data", onData);
    });
  }

  /** Stop and remove the container. */
  async stop(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    try {
      execSync(`docker stop ${this.containerName}`, { stdio: "pipe" });
    } catch {
      /* already stopped */
    }
    try {
      execSync(`docker rm ${this.containerName}`, { stdio: "pipe" });
    } catch {
      /* already removed */
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      await tcpConnect(host, port, 3000);
      return; // connected — done
    } catch {
      attempt++;
      const delay = Math.min(1000 * Math.pow(1.5, attempt - 1), 5000);
      await sleep(delay);
    }
  }
  throw new Error(
    `Timed out waiting for ${host}:${port} after ${timeoutMs}ms`
  );
}

function tcpConnect(
  host: string,
  port: number,
  connectTimeoutMs = 5000
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timeout`));
    }, connectTimeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
