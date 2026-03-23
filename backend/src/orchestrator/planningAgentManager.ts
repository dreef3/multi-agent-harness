import type Dockerode from "dockerode";
import { PassThrough } from "stream";
import { config } from "../config.js";

export type PlanningAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolName: string; args?: Record<string, unknown> }
  | { type: "message_complete" }
  | { type: "conversation_complete" };

interface ProjectState {
  containerId: string;
  stream: NodeJS.ReadWriteStream;
  stdout: PassThrough;
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

    const { stream, stdout } = await this.attachContainer(containerId);
    const state: ProjectState = {
      containerId,
      stream,
      stdout,
      lineBuffer: "",
      isStreaming: false,
      promptPending: false,
      wsConnectionCount: 0,
      outputHandlers: new Set(),
    };
    this.projects.set(projectId, state);
    this.listenStdout(projectId, state);
  }

  async stopContainer(projectId: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    this.projects.delete(projectId);
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
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${config.piAgentVolume}:/pi-agent`],
        NetworkMode: config.subAgentNetwork,
      },
    });
    console.log(`[PlanningAgentManager] created container ${container.id} name=${name}`);
    return container.id;
  }

  private attachContainer(containerId: string): Promise<{ stream: NodeJS.ReadWriteStream; stdout: PassThrough }> {
    return new Promise((resolve, reject) => {
      this.docker.getContainer(containerId).attach(
        { stream: true, stdin: true, stdout: true, stderr: true },
        (err: Error | null, stream?: NodeJS.ReadWriteStream) => {
          if (err) { reject(err); return; }
          if (!stream) { reject(new Error("attach: no stream returned")); return; }
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          stderr.on("data", (chunk: Buffer) =>
            console.error(`[planning-agent stderr]`, chunk.toString())
          );
          (this.docker as unknown as { modem: { demuxStream: (s: unknown, o: unknown, e: unknown) => void } })
            .modem.demuxStream(stream, stdout, stderr);
          resolve({ stream, stdout });
        }
      );
    });
  }

  private listenStdout(projectId: string, state: ProjectState): void {
    state.stdout.on("data", (chunk: Buffer) => {
      state.lineBuffer += chunk.toString();
      const lines = state.lineBuffer.split("\n");
      state.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleRpcLine(projectId, state, trimmed);
      }
    });
  }

  private handleRpcLine(projectId: string, state: ProjectState, line: string): void {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }

    const type = obj.type as string;

    if (type === "agent_start") { state.isStreaming = true; return; }

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
    state.stream.write(cmd);
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
