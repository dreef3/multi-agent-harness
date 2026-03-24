import type Dockerode from "dockerode";
import { PassThrough } from "stream";
import { Socket } from "net";
import { config } from "../config.js";

export type PlanningAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolName: string; args?: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result?: unknown; isError?: boolean }
  | { type: "thinking"; text: string }
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
  lifecycleState: "running" | "idle" | "stopping" | "crashed";
  stopTimer: ReturnType<typeof setTimeout> | null;
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
  private readonly commitInProgress = new Set<string>();

  constructor(private readonly docker: Dockerode) {}

  isRunning(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  async ensureRunning(
    projectId: string,
    repos: Array<{ id?: string; name: string; url: string }>
  ): Promise<void> {
    if (this.projects.has(projectId)) return;

    const containerName = `planning-${projectId}`;
    let containerId: string;

    const existing = await this.findExistingContainer(containerName);
    if (existing) {
      containerId = existing;
      try {
        const info = await this.docker.getContainer(containerId).inspect();
        if (!info.State.Running) {
          await this.docker.getContainer(containerId).start();
          console.log(`[PlanningAgentManager] restarted stopped container ${containerId} for project ${projectId}`);
        } else {
          console.log(`[PlanningAgentManager] reusing running container ${containerId} for project ${projectId}`);
        }
      } catch {
        console.log(`[PlanningAgentManager] could not inspect ${containerId}, attempting start`);
        try { await this.docker.getContainer(containerId).start(); } catch { /* ignore */ }
      }
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
      lifecycleState: "running",
      stopTimer: null,
    };
    this.projects.set(projectId, state);
    this.listenTcp(projectId, state);
  }

  async stopContainer(projectId: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    state.lifecycleState = "stopping";
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    this.projects.delete(projectId);
    state.tcpSocket.destroy();
    await this.commitSessionLog(projectId);
    try {
      await this.docker.getContainer(state.containerId).stop({ t: 10 });
      console.log(`[PlanningAgentManager] stopped container ${state.containerId}`);
    } catch (err) {
      console.warn(`[PlanningAgentManager] stop failed (may already be stopped):`, err);
    }
    try {
      await this.docker.getContainer(state.containerId).remove();
      console.log(`[PlanningAgentManager] removed container ${state.containerId}`);
    } catch (removeErr) {
      console.warn(`[PlanningAgentManager] remove failed (non-fatal):`, removeErr);
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
    repos: Array<{ id?: string; name: string; url: string }>
  ): Promise<string> {
    // GITHUB_TOKEN is intentionally excluded — clone URLs are pre-authenticated in GIT_CLONE_URLS
    const providerEnvVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY",
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
      const currentState = this.projects.get(projectId);
      if (currentState && currentState.lifecycleState !== "stopping") {
        console.error(`[PlanningAgentManager] TCP socket closed unexpectedly for ${projectId} — marking as crashed`);
        if (currentState.stopTimer) {
          clearTimeout(currentState.stopTimer);
          currentState.stopTimer = null;
        }
        currentState.lifecycleState = "crashed";
        this.projects.delete(projectId);
        // Unblock any WS clients waiting for a response
        this.emit(currentState, { type: "conversation_complete" });
      } else {
        console.log(`[PlanningAgentManager] TCP RPC socket closed for ${projectId}`);
      }
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
    if (!["agent_start", "message_update", "tool_execution_start", "tool_execution_end", "message_end", "agent_end",
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

    if (type === "tool_execution_end") {
      this.emit(state, {
        type: "tool_result",
        toolName: obj.toolName as string,
        result: obj.result,
        isError: obj.isError as boolean | undefined,
      });
      return;
    }

    if (type === "thinking_delta") {
      this.emit(state, { type: "thinking", text: (obj.delta as string) ?? "" });
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
      void this.commitSessionLog(projectId);
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
    if (state.wsConnectionCount > 0 || state.isStreaming || state.promptPending) return;
    if (state.lifecycleState !== "running") return;
    if (state.stopTimer) return; // already counting down

    state.lifecycleState = "idle";
    state.stopTimer = setTimeout(() => {
      state.stopTimer = null;
      console.log(`[PlanningAgentManager] grace period expired for ${projectId}, stopping`);
      void this.stopContainer(projectId);
    }, 120_000);
    console.log(`[PlanningAgentManager] ${projectId} → idle (2-min grace timer started)`);
  }

  async sendPrompt(projectId: string, message: string): Promise<void> {
    if (!this.projects.has(projectId)) {
      // Container stopped (e.g. idle timeout). Restart it so the system message reaches the agent.
      console.log(`[PlanningAgentManager] sendPrompt: no container for ${projectId}, restarting...`);
      try {
        const { getProject } = await import("../store/projects.js");
        const { listRepositories } = await import("../store/repositories.js");
        const project = getProject(projectId);
        if (!project) {
          console.warn(`[PlanningAgentManager] sendPrompt: project ${projectId} not found, cannot restart`);
          return;
        }
        const allRepos = listRepositories().filter(r => project.repositoryIds.includes(r.id));
        const ghToken = process.env.GITHUB_TOKEN;
        const repos = allRepos.map(r => ({
          id: r.id,
          name: r.name,
          url: ghToken && r.cloneUrl.startsWith("https://github.com/")
            ? r.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
            : r.cloneUrl,
        }));
        await this.ensureRunning(projectId, repos);
      } catch (err) {
        console.error(`[PlanningAgentManager] sendPrompt: failed to restart container for ${projectId}:`, err);
        return;
      }
    }
    const state = this.projects.get(projectId);
    if (!state) {
      console.warn(`[PlanningAgentManager] sendPrompt: still no container for project ${projectId} after restart`);
      return;
    }
    // Cancel any pending stop timer — a prompt means the agent is actively needed
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
      state.lifecycleState = "running";
      console.log(`[PlanningAgentManager] ${projectId} → running (stop timer cancelled by sendPrompt)`);
    }
    state.promptPending = true;
    const cmd = JSON.stringify({
      type: "prompt",
      message,
      ...(state.isStreaming ? { streamingBehavior: "followUp" } : {}),
    }) + "\n";
    state.tcpSocket.write(cmd);
  }

  injectMessage(projectId: string, text: string): void {
    const state = this.projects.get(projectId);
    if (!state) {
      console.warn(`[PlanningAgentManager] injectMessage: no container for ${projectId}, dropping message`);
      return;
    }
    state.tcpSocket.write(JSON.stringify({ type: "prompt", message: text }) + "\n");
  }

  onOutput(projectId: string, handler: (event: PlanningAgentEvent) => void): () => void {
    const state = this.projects.get(projectId);
    if (!state) return () => {};
    state.outputHandlers.add(handler);
    return () => state.outputHandlers.delete(handler);
  }

  incrementConnections(projectId: string): void {
    const state = this.projects.get(projectId);
    if (!state) return;
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
      state.lifecycleState = "running";
      console.log(`[PlanningAgentManager] ${projectId} → running (stop timer cancelled by new connection)`);
    }
    state.wsConnectionCount++;
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

  async cleanupStaleContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      const stale = containers.filter((c) => {
        const name = (c.Names?.[0] ?? "").replace(/^\//, "");
        return (name.startsWith("planning-") || name.startsWith("task-")) && c.State !== "running";
      });
      for (const c of stale) {
        try {
          await this.docker.getContainer(c.Id).remove({ force: true });
          console.log(`[PlanningAgentManager] cleaned up stale container ${c.Names?.[0]}`);
        } catch (err) {
          console.warn(`[PlanningAgentManager] cleanup failed for ${c.Id}:`, err);
        }
      }
      if (stale.length > 0) {
        console.log(`[PlanningAgentManager] cleaned up ${stale.length} stale container(s)`);
      }
    } catch (err) {
      console.warn(`[PlanningAgentManager] container cleanup error:`, err);
    }
  }

  private async commitSessionLog(projectId: string): Promise<void> {
    if (this.commitInProgress.has(projectId)) return;
    this.commitInProgress.add(projectId);
    try {
      const sessionPath = `/pi-agent/sessions/planning-${projectId}.jsonl`;
      let content: string;
      try {
        const { readFile } = await import("node:fs/promises");
        content = await readFile(sessionPath, "utf-8");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        console.warn(`[PlanningAgentManager] could not read session log for ${projectId}:`, err);
        return;
      }

      const { getProject } = await import("../store/projects.js");
      const project = getProject(projectId);
      if (!project?.primaryRepositoryId) {
        console.warn(`[PlanningAgentManager] no primary repository for ${projectId}, skipping session log commit`);
        return;
      }

      const { getRepository } = await import("../store/repositories.js");
      const repo = getRepository(project.primaryRepositoryId);
      if (!repo || repo.provider !== "github") {
        console.warn(`[PlanningAgentManager] primary repo for ${projectId} is not GitHub, skipping`);
        return;
      }

      if (!repo.defaultBranch) {
        console.warn(`[PlanningAgentManager] primary repo for ${projectId} has no defaultBranch, skipping session log commit`);
        return;
      }

      try {
        const { GitHubConnector } = await import("../connectors/github.js");
        const connector = new GitHubConnector();
        await connector.commitFile(
          repo,
          repo.defaultBranch,
          `.harness/logs/planning-agent/${projectId}.jsonl`,
          content,
          `chore: save planning agent session log [${projectId}]`
        );
        console.log(`[PlanningAgentManager] session log committed for ${projectId}`);
      } catch (err) {
        console.warn(`[PlanningAgentManager] failed to commit session log for ${projectId}:`, err);
      }
    } finally {
      this.commitInProgress.delete(projectId);
    }
  }
}
