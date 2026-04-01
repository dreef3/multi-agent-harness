import type { ContainerRuntime, AgentContainerSpec } from "./containerRuntime.js";
import { Socket } from "net";
import { EventEmitter } from "node:events";
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { config } from "../config.js";
import { tracer, meter } from "../telemetry.js";
import { appendEvent } from "../store/agentEvents.js";

const toolCallCounter = meter.createCounter("harness.tool_calls.total", {
  description: "Total tool calls made by the planning agent",
});
const toolCallDuration = meter.createHistogram("harness.tool_calls.duration_ms", {
  description: "Duration of planning agent tool calls in milliseconds",
  unit: "ms",
});
const tokensInput = meter.createCounter("harness.tokens.input", {
  description: "Input tokens consumed by the planning agent",
  unit: "tokens",
});
const tokensOutput = meter.createCounter("harness.tokens.output", {
  description: "Output tokens produced by the planning agent",
  unit: "tokens",
});
const tokensCacheRead = meter.createCounter("harness.tokens.cache_read", {
  description: "Cache-read tokens consumed by the planning agent",
  unit: "tokens",
});

export type PlanningAgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolName: string; args?: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result?: unknown; isError?: boolean }
  | { type: "thinking"; text: string }
  | { type: "message_complete" }
  | { type: "conversation_complete" }
  | { type: "agent_error"; message: string };

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
  // OTEL tracing
  sessionSpan: Span | null;  // covers entire agent session (agent_start → agent_end)
  turnSpan: Span | null;     // covers a single turn (turn_start → turn_end)
  toolSpans: Map<string, Span>; // toolCallId → span
}

let instance: PlanningAgentManager | null = null;

export function setPlanningAgentManager(mgr: PlanningAgentManager): void {
  instance = mgr;
}

export function getPlanningAgentManager(): PlanningAgentManager {
  if (!instance) throw new Error("[PlanningAgentManager] not initialised");
  return instance;
}

export class PlanningAgentManager extends EventEmitter {
  private projects = new Map<string, ProjectState>();
  private readonly commitInProgress = new Set<string>();
  private toolCallStartTimes = new Map<string, number>(); // toolCallId → start timestamp

  constructor(private readonly runtime: ContainerRuntime) {
    super();
  }

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
        const status = await this.runtime.getStatus(containerId);
        if (status !== "running") {
          console.log(`[PlanningAgentManager] planning agent not running for project ${projectId} — starting existing stopped container ${containerId}`);
          await this.runtime.startContainer(containerId);
          console.log(`[PlanningAgentManager] started container ${containerId} for project ${projectId}`);
        } else {
          console.log(`[PlanningAgentManager] reusing running container ${containerId} for project ${projectId}`);
        }
      } catch {
        console.log(`[PlanningAgentManager] planning agent not running for project ${projectId} — could not inspect ${containerId}, attempting start`);
        try {
          await this.runtime.startContainer(containerId);
          console.log(`[PlanningAgentManager] started container ${containerId} for project ${projectId}`);
        } catch { /* ignore */ }
      }
    } else {
      console.log(`[PlanningAgentManager] planning agent not running for project ${projectId} — creating new container`);
      containerId = await this.createContainer(projectId, containerName, repos);
      await this.runtime.startContainer(containerId);
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
      sessionSpan: null,
      turnSpan: null,
      toolSpans: new Map(),
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
      console.log(`[PlanningAgentManager] stopping container ${state.containerId} for project ${projectId}`);
      await this.runtime.stopContainer(state.containerId, 10);
      console.log(`[PlanningAgentManager] stopped container ${state.containerId} for project ${projectId}`);
    } catch (err) {
      console.warn(`[PlanningAgentManager] stop failed (may already be stopped):`, err);
    }
    try {
      console.log(`[PlanningAgentManager] removing container ${state.containerId} for project ${projectId}`);
      await this.runtime.removeContainer(state.containerId);
      console.log(`[PlanningAgentManager] removed container ${state.containerId} for project ${projectId}`);
    } catch (removeErr) {
      console.warn(`[PlanningAgentManager] remove failed (non-fatal):`, removeErr);
    }
  }

  private async findExistingContainer(name: string): Promise<string | null> {
    try {
      // List all harness-managed containers and find one matching the given name
      const containers = await this.runtime.listByLabel("harness.managed", "true");
      const match = containers.find(c => c.name === name || c.name === `/${name}`);
      return match ? match.id : null;
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
    // API keys passed through; AGENT_PROVIDER and AGENT_MODEL are derived from config below
    const providerEnvVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENCODE_API_KEY",
      "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
      "COPILOT_GITHUB_TOKEN",
    ]
      .filter(k => process.env[k])
      .map(k => `${k}=${process.env[k]}`);

    // Always set provider + model explicitly from parsed config (AGENT_PLANNING_MODEL)
    providerEnvVars.push(`AGENT_PROVIDER=${config.agentProvider}`);
    providerEnvVars.push(`AGENT_MODEL=${config.planningModel}`);

    const image = config.planningAgentImage;

    const spec: AgentContainerSpec = {
      sessionId: projectId,
      image,
      name,
      env: [
        `GIT_CLONE_URLS=${JSON.stringify(repos)}`,
        `PROJECT_ID=${projectId}`,
        `BACKEND_URL=http://backend:3000`,
        `PI_CODING_AGENT_DIR=/pi-agent`,
        ...providerEnvVars,
      ],
      binds: [`${config.piAgentVolume}:/pi-agent`],
      memoryBytes: 0,
      nanoCpus: 0,
      networkMode: config.subAgentNetwork,
    };

    const containerId = await this.runtime.createContainer(spec);
    console.log(`[PlanningAgentManager] created container ${containerId} name=${name}`);
    return containerId;
  }

  /** Attach to container just to stream stderr to logs. Fire-and-forget. */
  private attachContainerStderr(containerId: string): void {
    void this.runtime.streamLogs(
      containerId,
      (line: string, isError: boolean) => {
        if (isError) {
          console.error(`[planning-agent stderr]`, line);
        }
      },
      true
    ).catch(() => { /* ignore stream errors */ });
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
        // End any open spans on crash
        currentState.turnSpan?.setStatus({ code: SpanStatusCode.ERROR, message: "container crashed" });
        currentState.turnSpan?.end();
        for (const span of currentState.toolSpans.values()) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "container crashed" });
          span.end();
        }
        currentState.sessionSpan?.setStatus({ code: SpanStatusCode.ERROR, message: "container crashed" });
        currentState.sessionSpan?.end();
        // Unblock any WS clients waiting for a response
        this.emitAgentEvent(projectId, currentState, { type: "conversation_complete" });
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
    if (!["agent_start", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "message_end", "agent_end",
         "extension_ui_request", "extension_error", "thinking_start", "thinking_delta", "thinking_end",
         "turn_start", "turn_end", "auto_retry_start", "auto_retry_end"].includes(type)) {
      console.log(`[PlanningAgentManager] unhandled event type="${type}" for ${projectId}: ${line.slice(0, 200)}`);
    }

    if (type === "agent_start") {
      state.isStreaming = true;
      console.log(`[PlanningAgentManager] agent_start for ${projectId}`);
      state.sessionSpan = tracer.startSpan("planning_agent.session", {
        attributes: { "project.id": projectId },
      });
      return;
    }

    if (type === "turn_start") {
      const parentCtx = state.sessionSpan
        ? trace.setSpan(context.active(), state.sessionSpan)
        : context.active();
      state.turnSpan = tracer.startSpan("planning_agent.turn", {
        attributes: { "project.id": projectId },
      }, parentCtx);
      return;
    }

    if (type === "turn_end") {
      const msg = obj.message as {
        model?: string; provider?: string; api?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      } | undefined;
      const usage = msg?.usage;
      const attrs = {
        "project.id": projectId,
        "model": msg?.model ?? "",
        "provider": msg?.provider ?? "",
      };
      if (usage) {
        if (usage.input)     tokensInput.add(usage.input, attrs);
        if (usage.output)    tokensOutput.add(usage.output, attrs);
        if (usage.cacheRead) tokensCacheRead.add(usage.cacheRead, attrs);
        if (state.turnSpan) {
          state.turnSpan.setAttributes({
            "llm.usage.input_tokens": usage.input ?? 0,
            "llm.usage.output_tokens": usage.output ?? 0,
            "llm.usage.cache_read_tokens": usage.cacheRead ?? 0,
            "llm.model": msg?.model ?? "",
            "llm.provider": msg?.provider ?? "",
          });
        }
      }
      state.turnSpan?.end();
      state.turnSpan = null;
      return;
    }

    if (type === "message_update") {
      const evt = obj.assistantMessageEvent as Record<string, unknown> | undefined;
      if (evt?.type === "text_delta" && typeof evt.delta === "string") {
        this.emitAgentEvent(projectId, state, { type: "delta", text: evt.delta });
      }
      return;
    }

    if (type === "tool_execution_start") {
      const toolName = obj.toolName as string;
      const toolCallId = projectId + ":" + ((obj.toolCallId as string | undefined) ?? toolName);
      this.toolCallStartTimes.set(toolCallId, Date.now());
      toolCallCounter.add(1, { "tool.name": toolName, "project.id": projectId });
      const parentCtx = state.turnSpan
        ? trace.setSpan(context.active(), state.turnSpan)
        : state.sessionSpan
          ? trace.setSpan(context.active(), state.sessionSpan)
          : context.active();
      const toolSpan = tracer.startSpan(`planning_agent.tool.${toolName}`, {
        attributes: { "project.id": projectId, "tool.name": toolName },
      }, parentCtx);
      state.toolSpans.set(toolCallId, toolSpan);
      this.emitAgentEvent(projectId, state, {
        type: "tool_call",
        toolName: toolName,
        args: obj.args as Record<string, unknown> | undefined,
      });
      return;
    }

    if (type === "tool_execution_end") {
      const toolName = obj.toolName as string;
      const toolCallId = projectId + ":" + ((obj.toolCallId as string | undefined) ?? toolName);
      const start = this.toolCallStartTimes.get(toolCallId);
      if (start !== undefined) {
        toolCallDuration.record(Date.now() - start, { "tool.name": toolName, "project.id": projectId });
        this.toolCallStartTimes.delete(toolCallId);
      }
      const toolSpan = state.toolSpans.get(toolCallId);
      if (toolSpan) {
        const isError = obj.isError as boolean | undefined;
        if (isError) toolSpan.setStatus({ code: SpanStatusCode.ERROR });
        toolSpan.end();
        state.toolSpans.delete(toolCallId);
      }
      this.emitAgentEvent(projectId, state, {
        type: "tool_result",
        toolName: toolName,
        result: obj.result,
        isError: obj.isError as boolean | undefined,
      });
      return;
    }

    if (type === "thinking_delta") {
      this.emitAgentEvent(projectId, state, { type: "thinking", text: (obj.delta as string) ?? "" });
      return;
    }

    if (type === "message_end") {
      const msg = obj.message as { stopReason?: string; content?: Array<{ type: string; text?: string }> } | undefined;
      if (msg?.stopReason === "error") {
        const errorText = (msg.content ?? [])
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("") || "The planning agent encountered an API error. Check your model provider configuration (AGENT_PROVIDER/AGENT_MODEL).";
        console.error(`[PlanningAgentManager] agent API error for ${projectId}: ${errorText}`);
        this.emitAgentEvent(projectId, state, { type: "agent_error", message: errorText });
      }
      this.emitAgentEvent(projectId, state, { type: "message_complete" });
      return;
    }

    if (type === "agent_end") {
      state.isStreaming = false;
      state.promptPending = false;
      // End any dangling spans
      state.turnSpan?.end();
      state.turnSpan = null;
      for (const span of state.toolSpans.values()) span.end();
      state.toolSpans.clear();
      state.sessionSpan?.end();
      state.sessionSpan = null;
      this.emitAgentEvent(projectId, state, { type: "conversation_complete" });
      void this.commitSessionLog(projectId);
      // Note: do NOT call checkStop here. The container lifecycle is driven by WS
      // connection count — it stops when the last client disconnects (decrementConnections).
      // Calling checkStop on agent_end races with incrementConnections and would stop
      // the container before the first prompt is ever sent.
      return;
    }
  }

  private emitAgentEvent(projectId: string, state: ProjectState, event: PlanningAgentEvent): void {
    for (const handler of state.outputHandlers) {
      try { handler(event); } catch { /* ignore handler errors */ }
    }
    this.emit(projectId, event);
    const { type, ...payload } = event;
    void appendEvent(`master-${projectId}`, { type, payload: payload as Record<string, unknown>, timestamp: new Date().toISOString() });
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

  async sendPrompt(projectId: string, message: string, context?: string): Promise<void> {
    if (!this.projects.has(projectId)) {
      // Container stopped (e.g. idle timeout). Restart it so the system message reaches the agent.
      console.log(`[PlanningAgentManager] planning agent not running for project ${projectId} — restarting before sending prompt`);
      try {
        const { getProject } = await import("../store/projects.js");
        const { listRepositories } = await import("../store/repositories.js");
        const project = await getProject(projectId);
        if (!project) {
          console.warn(`[PlanningAgentManager] sendPrompt: project ${projectId} not found, cannot restart`);
          return;
        }
        const allRepos = (await listRepositories()).filter((r: import("../models/types.js").Repository) => project.repositoryIds.includes(r.id));
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
      ...(context ? { context } : {}),
      ...(state.isStreaming ? { streamingBehavior: "followUp" } : {}),
    }) + "\n";
    state.tcpSocket.write(cmd);
  }

  async injectMessage(projectId: string, text: string): Promise<void> {
    if (!this.projects.has(projectId)) {
      console.log(`[PlanningAgentManager] injectMessage: no container for ${projectId}, restarting...`);
      try {
        const { getProject: getProj } = await import("../store/projects.js");
        const { listRepositories } = await import("../store/repositories.js");
        const project = await getProj(projectId);
        if (!project) {
          console.warn(`[PlanningAgentManager] injectMessage: project ${projectId} not found, cannot restart`);
          return;
        }
        const ghToken = process.env.GITHUB_TOKEN;
        const allRepos = (await listRepositories()).filter((r: import("../models/types.js").Repository) => project.repositoryIds.includes(r.id));
        const repoUrls = allRepos.map((r) => ({
          id: r.id,
          name: r.name,
          url: ghToken && r.cloneUrl.startsWith("https://github.com/")
            ? r.cloneUrl.replace("https://github.com/", `https://x-access-token:${ghToken}@github.com/`)
            : r.cloneUrl
        }));
        await this.ensureRunning(projectId, repoUrls);
      } catch (err) {
        console.error(`[PlanningAgentManager] injectMessage: failed to restart container for ${projectId}:`, err);
        return;
      }
    }
    const state = this.projects.get(projectId)!;
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
      const { getAgentSession } = await import("../store/agents.js");
      const { getProject } = await import("../store/projects.js");
      // List all harness-managed containers
      const containers = await this.runtime.listByLabel("harness.managed", "true");
      const harnessContainers = containers.filter((c) => {
        return c.name.startsWith("planning-") || c.name.startsWith("sub-");
      });

      let removedCount = 0;
      let stoppedOrphanCount = 0;

      for (const c of harnessContainers) {
        try {
          if (c.status !== "running") {
            // Remove stopped/exited harness containers regardless of DB state
            await this.runtime.removeContainer(c.id, true);
            console.log(`[PlanningAgentManager] removed stopped container ${c.name}`);
            removedCount++;
          } else {
            // Running container — check if it has a session label (sub-agents only)
            // Planning containers are identified by name prefix, not session label
            // For sub-agent containers, verify they belong to a known session/project
            // We can't check labels directly via ContainerRuntime; skip orphan check for now
            // as cleanupStaleContainers primarily targets stopped containers.
          }
        } catch (err) {
          console.warn(`[PlanningAgentManager] cleanup failed for ${c.name}:`, err);
        }
      }

      if (removedCount > 0 || stoppedOrphanCount > 0) {
        console.log(`[PlanningAgentManager] cleanup complete: ${removedCount} stopped container(s) removed, ${stoppedOrphanCount} orphan(s) stopped`);
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
      const project = await getProject(projectId);
      if (!project?.primaryRepositoryId) {
        console.warn(`[PlanningAgentManager] no primary repository for ${projectId}, skipping session log commit`);
        return;
      }

      const { getRepository } = await import("../store/repositories.js");
      const repo = await getRepository(project.primaryRepositoryId);
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
