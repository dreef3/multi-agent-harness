import type Dockerode from "dockerode";
import { PassThrough } from "stream";
import { Socket } from "net";
import { config } from "../config.js";

export type PlanningAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolName: string; args?: Record<string, unknown> }
  | { type: "message_complete" }
  | { type: "conversation_complete" };

interface ProjectState {
  containerId: string;
  containerName: string;
  tcpSocket: Socket;
  lineBuffer: string;
  isStreaming: boolean;
  promptPending: boolean;
  wsConnectionCount: number;
  outputHandlers: Set<(event: PlanningAgentEvent) => void>;
}

let instance: PlanningAgentManager | null = null;

export function setPlanningAgentManager(mgr: PlanningAgentManager): void {
  instance = mgr;
}

export function getPlanningAgentManager(): PlanningAgentManager {
  if (!instance) throw new Error("[PlanningAgentManager] not initialised");
  return instance;
}

export class PlanningAgentManager {
  private projects = new Map<string, ProjectState>();

  constructor(private readonly docker: Dockerode) {}

  isRunning(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  async ensureRunning(
    projectId: string,
    repos: Array<{ name: string; url: string }>
  ): Promise<void> {
    if (this.projects.has(projectId)) return;

    const containerName = `planning-${projectId}`;
    let containerId: string;

    const existing = await this.findExistingContainer(containerName);
    if (existing) {
      console.log(`[PlanningAgentManager] reusing existing container ${existing} for project ${projectId}`);
      containerId = existing;
    } else {
      containerId = await this.createContainer(projectId, containerName, repos);
      await this.docker.getContainer(containerId).start();
      console.log(`[PlanningAgentManager] started container ${containerId} for project ${projectId}`);
    }

    // Attach for stderr logging (fire-and-forget)
    this.attachContainerStderr(containerId);

    // Connect to the container's TCP RPC server (port 3333).
    // The container needs time to clone repos and initialise the session before it starts
    // listening, so we retry for up to 120 seconds.
    console.log(`[PlanningAgentManager] connecting to TCP RPC server for ${projectId}...`);
    const tcpSocket = await this.connectTcp(containerName, 3333, 120_000);
    console.log(`[PlanningAgentManager] TCP RPC connected for ${projectId}`);

    const state: ProjectState = {
      containerId,
      containerName,
      tcpSocket,
      lineBuffer: "",
      isStreaming: false,
      promptPending: false,
      wsConnectionCount: 0,
      outputHandlers: new Set(),
    };
    this.projects.set(projectId, state);
    this.listenTcp(projectId, state);
  }

  async stopContainer(projectId: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.projects.delete(projectId);
    state.tcpSocket.destroy();
    try {
      await this.docker.getContainer(state.containerId).stop({ t: 10 });
      console.log(`[PlanningAgentManager] stopped container ${state.containerId}`);
    } catch (err) {
      console.warn(`[PlanningAgentManager] stop failed (may already be stopped):`, err);
    }
  }

  private async findExistingContainer(name: string): Promise<string | null> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const match = containers.find(c =>
        c.Names?.some((n: string) => n === `/${name}` || n === name)
      );
      return match ? match.Id : null;
    } catch {
      return null;
    }
  }

  private async createContainer(
    projectId: string,
    name: string,
    repos: Array<{ name: string; url: string }>
  ): Promise<string> {
    const providerEnvVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "OPENCODE_API_KEY",
      "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "AGENT_PROVIDER", "AGENT_MODEL"]
      .filter(k => process.env[k])
      .map(k => `${k}=${process.env[k]}`);

    // Ensure AGENT_MODEL is always set from config (env passthrough only works if the backend
    // itself has AGENT_MODEL set; fall back to the configured master-agent model for the provider)
    const configuredModel = config.models?.[config.agentProvider as keyof typeof config.models]?.masterAgent?.model;
    if (configuredModel && !providerEnvVars.some(v => v.startsWith("AGENT_MODEL="))) {
      providerEnvVars.push(`AGENT_MODEL=${configuredModel}`);
    }

    const image = config.planningAgentImage;

    const container = await this.docker.createContainer({
      Image: image,
      name,
      Env: [
        `GIT_CLONE_URLS=${JSON.stringify(repos)}`,
        `PROJECT_ID=${projectId}`,
        `BACKEND_URL=http://backend:3000`,
        `PI_CODING_AGENT_DIR=/pi-agent`,
        ...providerEnvVars,
      ],
      HostConfig: {
        Binds: [`${config.piAgentVolume}:/pi-agent`],
        NetworkMode: config.subAgentNetwork,
      },
    });
    console.log(`[PlanningAgentManager] created container ${container.id} name=${name}`);
    return container.id;
  }

  /** Attach to container just to stream stderr to logs. Fire-and-forget. */
  private attachContainerStderr(containerId: string): void {
    this.docker.getContainer(containerId).attach(
      { stream: true, stdin: false, stdout: false, stderr: true },
      (err: Error | null, stream?: NodeJS.ReadWriteStream) => {
        if (err || !stream) return;
        const stderr = new PassThrough();
        stderr.on("data", (chunk: Buffer) =>
          console.error(`[planning-agent stderr]`, chunk.toString())
        );
        (this.docker as unknown as { modem: { demuxStream: (s: unknown, o: unknown, e: unknown) => void } })
          .modem.demuxStream(stream, new PassThrough(), stderr);
      }
    );
  }

  /** Connect to the planning agent's TCP RPC server with exponential backoff retry. */
  private async connectTcp(host: string, port: number, maxWaitMs: number): Promise<Socket> {
    const start = Date.now();
    let attempt = 0;
    while (true) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const s = new Socket();
          const timer = setTimeout(() => { s.destroy(); reject(new Error("connect timeout")); }, 5000);
          s.connect(port, host, () => { clearTimeout(timer); resolve(s); });
          s.on("error", (err) => { clearTimeout(timer); s.destroy(); reject(err); });
        });
        return socket;
      } catch (err) {
        attempt++;
        const elapsed = Date.now() - start;
        if (elapsed >= maxWaitMs) {
          throw new Error(`[PlanningAgentManager] TCP connect to ${host}:${port} timed out after ${maxWaitMs}ms`);
        }
        // Exponential backoff: 500ms, 1s, 2s, 4s, cap at 5s
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 5000);
        if (attempt % 10 === 0) {
          console.log(`[PlanningAgentManager] still waiting for TCP RPC (${host}:${port}, ${Math.round(elapsed / 1000)}s elapsed)...`);
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private listenTcp(projectId: string, state: ProjectState): void {
    state.tcpSocket.on("data", (chunk: Buffer) => {
      state.lineBuffer += chunk.toString();
      const lines = state.lineBuffer.split("\n");
      state.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleRpcLine(projectId, state, trimmed);
      }
    });

    state.tcpSocket.on("close", () => {
      console.log(`[PlanningAgentManager] TCP RPC socket closed for ${projectId}`);
    });

    state.tcpSocket.on("error", (err) => {
      console.error(`[PlanningAgentManager] TCP RPC socket error for ${projectId}:`, err.message);
    });
  }

  private handleRpcLine(projectId: string, state: ProjectState, line: string): void {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }

    const type = obj.type as string;

    // Log all responses (success or failure) for diagnostics
    if (type === "response") {
      console.log(`[PlanningAgentManager] response from agent for ${projectId}: cmd=${obj.command} success=${obj.success}`);
      if (!(obj.success as boolean)) {
        console.error(`[PlanningAgentManager] prompt error from agent for ${projectId}: ${JSON.stringify(obj)}`);
      }
      return;
    }
    if (!["agent_start", "message_update", "tool_execution_start", "message_end", "agent_end",
         "extension_ui_request", "extension_error", "thinking_start", "thinking_delta", "thinking_end"].includes(type)) {
      console.log(`[PlanningAgentManager] unhandled event type="${type}" for ${projectId}: ${line.slice(0, 200)}`);
    }

    if (type === "agent_start") { state.isStreaming = true; console.log(`[PlanningAgentManager] agent_start for ${projectId}`); return; }

    if (type === "message_update") {
      const evt = obj.assistantMessageEvent as Record<string, unknown> | undefined;
      if (evt?.type === "text_delta" && typeof evt.delta === "string") {
        this.emit(state, { type: "delta", text: evt.delta });
      }
      return;
    }

    if (type === "tool_execution_start") {
      this.emit(state, {
        type: "tool_call",
        toolName: obj.toolName as string,
        args: obj.args as Record<string, unknown> | undefined,
      });
      return;
    }

    if (type === "message_end") {
      this.emit(state, { type: "message_complete" });
      return;
    }

    if (type === "agent_end") {
      state.isStreaming = false;
      state.promptPending = false;
      this.emit(state, { type: "conversation_complete" });
      // Note: do NOT call checkStop here. The container lifecycle is driven by WS
      // connection count — it stops when the last client disconnects (decrementConnections).
      // Calling checkStop on agent_end races with incrementConnections and would stop
      // the container before the first prompt is ever sent.
      return;
    }
  }

  private emit(state: ProjectState, event: PlanningAgentEvent): void {
    for (const handler of state.outputHandlers) {
      try { handler(event); } catch { /* ignore handler errors */ }
    }
  }

  private checkStop(projectId: string, state: ProjectState): void {
    if (state.wsConnectionCount === 0 && !state.isStreaming && !state.promptPending) {
      console.log(`[PlanningAgentManager] no connections + idle — stopping container for ${projectId}`);
      void this.stopContainer(projectId);
    }
  }

  async sendPrompt(projectId: string, message: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) {
      console.warn(`[PlanningAgentManager] sendPrompt: no container for project ${projectId}`);
      return;
    }
    state.promptPending = true;
    const cmd = JSON.stringify({
      type: "prompt",
      message,
      ...(state.isStreaming ? { streamingBehavior: "followUp" } : {}),
    }) + "\n";
    state.tcpSocket.write(cmd);
  }

  onOutput(projectId: string, handler: (event: PlanningAgentEvent) => void): () => void {
    const state = this.projects.get(projectId);
    if (!state) return () => {};
    state.outputHandlers.add(handler);
    return () => state.outputHandlers.delete(handler);
  }

  incrementConnections(projectId: string): void {
    const state = this.projects.get(projectId);
    if (state) state.wsConnectionCount++;
  }

  decrementConnections(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    state.wsConnectionCount = Math.max(0, state.wsConnectionCount - 1);
    this.checkStop(projectId, state);
  }

  onProjectTerminal(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.checkStop(projectId, state);
  }
}
