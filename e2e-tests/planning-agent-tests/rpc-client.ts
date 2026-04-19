import { createConnection, Socket } from "net";
import { execSync, spawnSync } from "child_process";

export interface AcpEvent {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class AcpTestClient {
  private socket: Socket | null = null;
  private lineBuffer = "";
  readonly containerName: string;
  private nextId = 1;
  private sessionId: string | null = null;
  private pendingRequests = new Map<number, {
    resolve: (r: AcpEvent) => void;
    reject: (e: Error) => void;
  }>();
  private listeners = new Map<string, Set<Function>>();

  constructor(
    private readonly options: {
      projectId: string;
      agentType: string;
      provider?: string;
      model?: string;
      backendUrl?: string;
      mcpToken?: string;
      env?: string[];
    }
  ) {
    this.containerName = `agent-test-${options.agentType}-${options.projectId}`;
  }

  async start(connectTimeoutMs = 120_000): Promise<void> {
    const image = `multi-agent-harness/agent-${this.options.agentType}:latest`;
    const backendUrl = this.options.backendUrl ?? "http://localhost:19999";
    const mcpToken   = this.options.mcpToken   ?? "test-token";
    // Build docker run args as an array to avoid shell quoting issues with env values
    // that may contain spaces (e.g. PLANNING_SYSTEM_PROMPT).
    const envArgs: string[] = [
      "-e", `AGENT_ROLE=planning`,
      "-e", `PROJECT_ID=${this.options.projectId}`,
      "-e", `AGENT_PROVIDER=${this.options.provider ?? "github-copilot"}`,
      "-e", `AGENT_MODEL=${this.options.model ?? "gpt-5-mini"}`,
      // Pass both names: BACKEND_URL for legacy callers, HARNESS_API_URL for the extension
      "-e", `BACKEND_URL=${backendUrl}`,
      "-e", `HARNESS_API_URL=${backendUrl}`,
      "-e", `MCP_TOKEN=${mcpToken}`,
      ...(this.options.env ?? []).flatMap((e: string) => ["-e", e]),
    ];

    const result = spawnSync("docker", [
      "run", "-d",
      // --add-host makes host.docker.internal resolve to the Docker host gateway on Linux
      "--add-host=host.docker.internal:host-gateway",
      "--name", this.containerName,
      ...envArgs,
      image,
    ], { stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`docker run failed: ${result.stderr?.toString()}`);
    }

    const ip = execSync(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${this.containerName}`
    ).toString().trim();

    await waitForPort(ip, 3333, connectTimeoutMs);
    this.socket = await tcpConnect(ip, 3333);
    this.startListening();

    const initRes = await this.sendRequest("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (initRes.error) throw new Error(`initialize failed: ${initRes.error.message}`);

    const sessionRes = await this.sendRequest("session/new", { cwd: "/workspace", mcpServers: [] });
    if (sessionRes.error) throw new Error(`session/new failed: ${sessionRes.error.message}`);
    this.sessionId = (sessionRes.result?.sessionId as string) ?? null;
    if (!this.sessionId) throw new Error("session/new returned no sessionId");

    // Set the model if specified. Strip any provider prefix (e.g. "copilot/gpt-5-mini" → "gpt-5-mini")
    // so that pi-acp can look up the model by ID and find the correct provider.
    if (this.options.model) {
      const bareModel = this.options.model.includes("/")
        ? this.options.model.split("/").slice(1).join("/")
        : this.options.model;
      const modelRes = await this.sendRequest("session/set_model", {
        sessionId: this.sessionId,
        modelId: bareModel,
      });
      if (modelRes.error) {
        // Non-fatal: log and continue — the agent may still use its default model.
        process.stderr.write(`[rpc-client] session/set_model warning: ${modelRes.error.message}\n`);
      }
    }
  }

  async sendPrompt(message: string, timeoutMs = 90_000): Promise<AcpEvent[]> {
    if (!this.socket) throw new Error("Not connected");
    const events: AcpEvent[] = [];
    const id = this.nextId++;
    const params: Record<string, unknown> = { prompt: [{ type: "text", text: message }] };
    if (this.sessionId) params.sessionId = this.sessionId;
    this.socket.write(JSON.stringify({
      jsonrpc: "2.0", id, method: "session/prompt", params,
    }) + "\n");

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("event", handler);
        resolve(events);
      }, timeoutMs);
      const handler = (event: AcpEvent) => {
        events.push(event);
        // Resolve on either a successful result OR an error response for this request
        if (event.id === id && (event.result || event.error)) {
          clearTimeout(timer);
          this.off("event", handler);
          resolve(events);
        }
      };
      this.on("event", handler);
    });
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<AcpEvent> {
    const id = this.nextId++;
    this.socket!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30_000);
      this.pendingRequests.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private startListening(): void {
    this.socket!.on("data", (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as AcpEvent;
          if (msg.id != null && this.pendingRequests.has(msg.id)) {
            const p = this.pendingRequests.get(msg.id)!;
            this.pendingRequests.delete(msg.id);
            p.resolve(msg);
          }
          this.emit("event", msg);
        } catch {}
      }
    });
    this.socket!.on("error", (err: Error) => {
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(err);
        this.pendingRequests.delete(id);
      }
    });
    this.socket!.on("close", () => {
      const err = new Error("Socket closed");
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(err);
        this.pendingRequests.delete(id);
      }
    });
  }

  on(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: Function) { this.listeners.get(event)?.delete(fn); }
  private emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    try { execSync(`docker stop -t 1 ${this.containerName}`, { stdio: "pipe" }); } catch {}
    // Container removal is handled by the CI cleanup step (or caller) so that
    // the "Dump planning agent container logs on failure" step can capture logs.
  }
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try { const s = await tcpConnect(host, port, 3000); s.destroy(); return; }
    catch { attempt++; await new Promise(r => setTimeout(r, Math.min(1000 * 1.5 ** (attempt - 1), 5000))); }
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function tcpConnect(host: string, port: number, timeout = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("connect timeout")); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (err) => { clearTimeout(timer); socket.destroy(); reject(err); });
  });
}
