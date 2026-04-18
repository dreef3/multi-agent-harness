import type Dockerode from "dockerode";
import { Socket } from "net";
import { EventEmitter } from "node:events";
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { agentImage, config } from "../config.js";
import { tracer, meter } from "../telemetry.js";
import { appendEvent } from "../store/agentEvents.js";

// ── ACP JSON-RPC 2.0 types ────────────────────────────────────────────────────

interface AcpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface AcpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

type AcpMessage = AcpResponse | AcpNotification | (AcpRequest & { method: string });

// ── WS event union ────────────────────────────────────────────────────────────

export type WsAcpEvent =
  | { type: "acp:agent_message_chunk"; agentId: string; content: unknown }
  | { type: "acp:tool_call"; agentId: string; toolCallId: string; title: string; kind: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:tool_call_update"; agentId: string; toolCallId: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:plan"; agentId: string; items: unknown[] }
  | { type: "acp:turn_complete"; agentId: string; stopReason: string }
  | { type: "acp:error"; agentId: string; message: string }
  | { type: "agent:started"; agentId: string }
  | { type: "agent:stopped"; agentId: string }
  | { type: "agent:crashed"; agentId: string; message: string };

// ── AgentState ────────────────────────────────────────────────────────────────

export interface AgentState {
  containerId: string;
  containerName: string;
  tcpSocket: Socket;
  lineBuffer: string;
  acpSessionId: string | null;
  acpInitialized: boolean;
  isStreaming: boolean;
  promptPending: boolean;
  wsConnectionCount: number;
  outputHandlers: Set<(event: WsAcpEvent) => void>;
  lifecycleState: "running" | "idle" | "stopping" | "crashed";
  stopTimer: ReturnType<typeof setTimeout> | null;
  sessionSpan: Span | null;
  turnSpan: Span | null;
  toolSpans: Map<string, Span>;
  pendingRequests: Map<number, { resolve: (r: AcpResponse) => void; reject: (e: Error) => void }>;
  nextRequestId: number;
}

// ── OTEL instruments ──────────────────────────────────────────────────────────

const toolCallCounter = meter.createCounter("harness.tool_calls.total", {
  description: "Total tool calls made by the agent",
});
const toolCallDuration = meter.createHistogram("harness.tool_calls.duration_ms", {
  description: "Duration of agent tool calls in milliseconds",
  unit: "ms",
});
const tokensInput = meter.createCounter("harness.tokens.input", {
  description: "Input tokens consumed by the agent",
  unit: "tokens",
});
const tokensOutput = meter.createCounter("harness.tokens.output", {
  description: "Output tokens produced by the agent",
  unit: "tokens",
});

// ── Singleton ─────────────────────────────────────────────────────────────────

let instance: AcpAgentManager | null = null;

export function setAcpAgentManager(mgr: AcpAgentManager): void {
  instance = mgr;
}

export function getAcpAgentManager(): AcpAgentManager {
  if (!instance) throw new Error("[AcpAgentManager] not initialised");
  return instance;
}

// ── AcpAgentManager ───────────────────────────────────────────────────────────

export class AcpAgentManager extends EventEmitter {
  /** Registry keyed by agentId: planning-{projectId} or sub-{taskId} */
  private agents = new Map<string, AgentState>();
  /** toolCallId → start timestamp (ms) */
  private toolCallStartTimes = new Map<string, number>();
  /** In-flight ensureRunning promises, keyed by agentId — prevents concurrent double-starts */
  private inFlightEnsure = new Map<string, Promise<void>>();

  constructor(private readonly docker: Dockerode) {
    super();
  }

  isRunning(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Connect to an already-started container's TCP ACP server and perform the
   * ACP initialize + session/new handshake.  Returns the populated AgentState.
   */
  async connectAndInitialize(
    agentId: string,
    host: string,
    port: number,
    containerId?: string,
    containerName?: string,
  ): Promise<AgentState> {
    const socket = await this.connectTcp(host, port, 120_000);

    const state: AgentState = {
      containerId: containerId ?? "",
      containerName: containerName ?? agentId,
      tcpSocket: socket,
      lineBuffer: "",
      acpSessionId: null,
      acpInitialized: false,
      isStreaming: false,
      promptPending: false,
      wsConnectionCount: 0,
      outputHandlers: new Set(),
      lifecycleState: "running",
      stopTimer: null,
      sessionSpan: tracer.startSpan("acp_agent.session", {
        attributes: { "agent.id": agentId },
      }),
      turnSpan: null,
      toolSpans: new Map(),
      pendingRequests: new Map(),
      nextRequestId: 1,
    };

    this.agents.set(agentId, state);
    this.listenTcp(agentId, state);

    // ACP handshake: initialize
    const initRes = await this.sendRequest(state, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    if (initRes.error) {
      throw new Error(`[AcpAgentManager] initialize failed: ${initRes.error.message}`);
    }
    state.acpInitialized = true;

    // ACP handshake: session/new
    const sessionRes = await this.sendRequest(state, "session/new", {
      cwd: "/workspace",
      mcpServers: [],
    });
    if (sessionRes.error) {
      throw new Error(`[AcpAgentManager] session/new failed: ${sessionRes.error.message}`);
    }
    state.acpSessionId = (sessionRes.result?.sessionId as string) ?? null;

    console.log(`[AcpAgentManager] agent ${agentId} initialized, sessionId=${state.acpSessionId}`);
    return state;
  }

  /**
   * Find or create a Docker container for the given agentId, start it, then
   * perform the ACP handshake.  Concurrent callers share a single in-flight
   * promise so the container is never started twice.
   */
  async ensureRunning(
    agentId: string,
    agentType: string,
    role: "planning" | "implementation",
    env?: string[],
  ): Promise<void> {
    if (this.agents.has(agentId)) return;
    const existing = this.inFlightEnsure.get(agentId);
    if (existing) return existing;
    const promise = this._doEnsureRunning(agentId, agentType, role, env);
    this.inFlightEnsure.set(agentId, promise);
    promise.finally(() => this.inFlightEnsure.delete(agentId)).catch(() => {});
    return promise;
  }

  private async _doEnsureRunning(
    agentId: string,
    agentType: string,
    role: "planning" | "implementation",
    env?: string[],
  ): Promise<void> {
    if (this.agents.has(agentId)) return;

    const containerName = agentId;
    let containerId: string;

    const existingContainer = await this.findExistingContainer(containerName);
    if (existingContainer) {
      containerId = existingContainer;
      try {
        const info = await this.docker.getContainer(containerId).inspect();
        if (!info.State.Running) {
          console.log(`[AcpAgentManager] container ${containerName} exists but is stopped — starting`);
          await this.docker.getContainer(containerId).start();
        } else {
          console.log(`[AcpAgentManager] reusing running container ${containerName}`);
        }
      } catch {
        console.log(`[AcpAgentManager] could not inspect ${containerName}, attempting start`);
        try { await this.docker.getContainer(containerId).start(); } catch { /* ignore */ }
      }
    } else {
      console.log(`[AcpAgentManager] creating new container ${containerName} (image=${agentImage(agentType)} role=${role})`);
      containerId = await this.createContainer(agentId, containerName, agentType, env);
      await this.docker.getContainer(containerId).start();
      console.log(`[AcpAgentManager] started container ${containerId} name=${containerName}`);
    }

    console.log(`[AcpAgentManager] connecting to ACP TCP server for ${agentId}...`);
    await this.connectAndInitialize(agentId, containerName, 3333, containerId, containerName);

    // Update containerId now that we have it (connectAndInitialize may have set "")
    const state = this.agents.get(agentId);
    if (state) {
      state.containerId = containerId;
      state.containerName = containerName;
    }

    // Set the model so pi-acp uses the configured model instead of its default (gpt-4o).
    // Extract from AGENT_MODEL=<value> in the env array, strip any provider prefix
    // (e.g. "copilot/gpt-5-mini" → "gpt-5-mini") so pi-acp can look it up by bare ID.
    const agentModelEnv = (env ?? []).find(e => e.startsWith("AGENT_MODEL="));
    if (agentModelEnv && state) {
      const rawModel = agentModelEnv.slice("AGENT_MODEL=".length);
      const bareModel = rawModel.includes("/") ? rawModel.split("/").slice(1).join("/") : rawModel;
      const modelRes = await this.sendRequest(state, "session/set_model", {
        sessionId: state.acpSessionId,
        modelId: bareModel,
      });
      if (modelRes.error) {
        console.warn(`[AcpAgentManager] session/set_model warning for ${agentId}: ${modelRes.error.message}`);
      } else {
        console.log(`[AcpAgentManager] session/set_model → ${bareModel} for ${agentId}`);
      }
    }

    this.emitWsEvent(agentId, { type: "agent:started", agentId });
  }

  async sendPrompt(agentId: string, message: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`[AcpAgentManager] agent ${agentId} not found`);

    // Cancel stop timer if active
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
      state.lifecycleState = "running";
      console.log(`[AcpAgentManager] ${agentId} → running (stop timer cancelled by sendPrompt)`);
    }

    state.promptPending = true;
    state.isStreaming = true;

    // Start OTEL turn span as child of session span
    const parentCtx = state.sessionSpan
      ? trace.setSpan(context.active(), state.sessionSpan)
      : context.active();
    state.turnSpan = tracer.startSpan("acp_agent.turn", {
      attributes: { "agent.id": agentId },
    }, parentCtx);

    // session/prompt — response (not notification) carries the stopReason.
    // Use a 5-minute timeout: a single planning turn can take >120s under CI
    // load because it involves LLM generation plus multiple GitHub API calls
    // (branch creation, file commits, PR creation) via write_planning_document.
    let res: AcpResponse;
    try {
      res = await this.sendRequest(state, "session/prompt", {
        sessionId: state.acpSessionId,
        prompt: [{ type: "text", text: message }],
      }, 300_000);
    } catch (err) {
      // Reset streaming state so the stop timer and subsequent prompts work correctly
      state.isStreaming = false;
      state.promptPending = false;
      state.turnSpan?.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      state.turnSpan?.end();
      state.turnSpan = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emitWsEvent(agentId, { type: "acp:error", agentId, message: errMsg });
      this.emitWsEvent(agentId, { type: "acp:turn_complete", agentId, stopReason: "timeout" });
      throw err;
    }

    // Handle turn completion from the response
    const stopReason = (res.result?.stopReason as string) ?? (res.error ? "error" : "unknown");

    state.turnSpan?.setStatus(
      res.error ? { code: SpanStatusCode.ERROR, message: res.error.message } : { code: SpanStatusCode.OK }
    );
    state.turnSpan?.end();
    state.turnSpan = null;
    state.isStreaming = false;
    state.promptPending = false;

    if (res.error) {
      this.emitWsEvent(agentId, { type: "acp:error", agentId, message: res.error.message });
    }
    this.emitWsEvent(agentId, { type: "acp:turn_complete", agentId, stopReason });
  }

  async stopAgent(agentId: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;

    state.lifecycleState = "stopping";
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    this.agents.delete(agentId);

    // Reject any pending requests
    for (const [, pending] of state.pendingRequests) {
      pending.reject(new Error(`[AcpAgentManager] agent ${agentId} stopped`));
    }
    state.pendingRequests.clear();

    state.tcpSocket.destroy();

    // End OTEL spans
    state.turnSpan?.end();
    state.turnSpan = null;
    for (const span of state.toolSpans.values()) span.end();
    state.toolSpans.clear();
    state.sessionSpan?.end();
    state.sessionSpan = null;

    // Stop + remove Docker container
    try {
      console.log(`[AcpAgentManager] stopping container ${state.containerId} for ${agentId}`);
      await this.docker.getContainer(state.containerId).stop({ t: 10 });
    } catch (err) {
      console.warn(`[AcpAgentManager] stop failed for ${agentId} (may already be stopped):`, err);
    }
    try {
      await this.docker.getContainer(state.containerId).remove();
      console.log(`[AcpAgentManager] removed container ${state.containerId} for ${agentId}`);
    } catch (err) {
      console.warn(`[AcpAgentManager] remove failed for ${agentId} (non-fatal):`, err);
    }

    this.emitWsEvent(agentId, { type: "agent:stopped", agentId });
  }

  onOutput(agentId: string, handler: (event: WsAcpEvent) => void): () => void {
    const state = this.agents.get(agentId);
    if (!state) return () => {};
    state.outputHandlers.add(handler);
    return () => state.outputHandlers.delete(handler);
  }

  incrementConnections(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
      state.lifecycleState = "running";
      console.log(`[AcpAgentManager] ${agentId} → running (stop timer cancelled by new connection)`);
    }
    state.wsConnectionCount++;
  }

  decrementConnections(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.wsConnectionCount = Math.max(0, state.wsConnectionCount - 1);
    this.checkStop(agentId, state);
  }

  async cleanupStaleContainers(): Promise<void> {
    try {
      const { getAgentSession } = await import("../store/agents.js");
      const { getProject } = await import("../store/projects.js");
      const containers = await this.docker.listContainers({ all: true });
      const harnessContainers = containers.filter((c) => {
        const name = (c.Names?.[0] ?? "").replace(/^\//, "");
        return name.startsWith("planning-") || name.startsWith("sub-");
      });

      let removedCount = 0;
      let stoppedOrphanCount = 0;

      for (const c of harnessContainers) {
        const name = c.Names?.[0] ?? c.Id;
        try {
          if (c.State !== "running") {
            await this.docker.getContainer(c.Id).remove({ force: true });
            console.log(`[AcpAgentManager] removed stopped container ${name}`);
            removedCount++;
          } else {
            const sessionId = c.Labels?.["harness.session-id"];
            if (sessionId) {
              const session = await getAgentSession(sessionId);
              if (!session || !(await getProject(session.projectId))) {
                console.log(`[AcpAgentManager] stopping orphan container ${name} (session=${sessionId})`);
                await this.docker.getContainer(c.Id).stop({ t: 5 });
                await this.docker.getContainer(c.Id).remove({ force: true });
                console.log(`[AcpAgentManager] removed orphan container ${name}`);
                stoppedOrphanCount++;
              }
            }
          }
        } catch (err) {
          console.warn(`[AcpAgentManager] cleanup failed for ${name}:`, err);
        }
      }

      if (removedCount > 0 || stoppedOrphanCount > 0) {
        console.log(`[AcpAgentManager] cleanup complete: ${removedCount} stopped removed, ${stoppedOrphanCount} orphans stopped`);
      }
    } catch (err) {
      console.warn(`[AcpAgentManager] container cleanup error:`, err);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private checkStop(agentId: string, state: AgentState): void {
    if (state.wsConnectionCount > 0 || state.isStreaming || state.promptPending) return;
    if (state.lifecycleState !== "running") return;
    if (state.stopTimer) return;

    state.lifecycleState = "idle";
    state.stopTimer = setTimeout(() => {
      state.stopTimer = null;
      console.log(`[AcpAgentManager] grace period expired for ${agentId}, stopping`);
      void this.stopAgent(agentId);
    }, 120_000);
    console.log(`[AcpAgentManager] ${agentId} → idle (2-min grace timer started)`);
  }

  private listenTcp(agentId: string, state: AgentState): void {
    state.tcpSocket.on("data", (chunk: Buffer) => {
      state.lineBuffer += chunk.toString();
      const lines = state.lineBuffer.split("\n");
      state.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as AcpMessage;
          this.handleAcpMessage(agentId, state, msg);
        } catch {
          console.warn(`[AcpAgentManager] failed to parse line for ${agentId}: ${trimmed.slice(0, 200)}`);
        }
      }
    });

    state.tcpSocket.on("close", () => {
      const currentState = this.agents.get(agentId);
      if (currentState && currentState.lifecycleState !== "stopping") {
        console.error(`[AcpAgentManager] TCP socket closed unexpectedly for ${agentId} — marking as crashed`);
        if (currentState.stopTimer) {
          clearTimeout(currentState.stopTimer);
          currentState.stopTimer = null;
        }
        currentState.lifecycleState = "crashed";
        this.agents.delete(agentId);

        // Reject all pending requests
        for (const [, pending] of currentState.pendingRequests) {
          pending.reject(new Error(`[AcpAgentManager] agent ${agentId} crashed`));
        }
        currentState.pendingRequests.clear();

        // End all open spans
        currentState.turnSpan?.setStatus({ code: SpanStatusCode.ERROR, message: "container crashed" });
        currentState.turnSpan?.end();
        for (const span of currentState.toolSpans.values()) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "container crashed" });
          span.end();
        }
        currentState.sessionSpan?.setStatus({ code: SpanStatusCode.ERROR, message: "container crashed" });
        currentState.sessionSpan?.end();

        this.emitWsEvent(agentId, { type: "agent:crashed", agentId, message: "TCP socket closed unexpectedly" });
      } else {
        console.log(`[AcpAgentManager] TCP socket closed for ${agentId}`);
      }
    });

    state.tcpSocket.on("error", (err) => {
      console.error(`[AcpAgentManager] TCP socket error for ${agentId}:`, err.message);
    });
  }

  private handleAcpMessage(agentId: string, state: AgentState, msg: AcpMessage): void {
    // Response to a pending request (has numeric id)
    if ("id" in msg && typeof msg.id === "number" && !("method" in msg)) {
      const response = msg as AcpResponse;
      const pending = state.pendingRequests.get(response.id);
      if (pending) {
        state.pendingRequests.delete(response.id);
        pending.resolve(response);
      } else {
        console.warn(`[AcpAgentManager] no pending request for id=${response.id} on ${agentId}`);
      }
      return;
    }

    // Notification or permission request (has method, may have id)
    if ("method" in msg) {
      const method = (msg as AcpNotification).method;

      // Guard: session/request_permission
      if (method === "session/request_permission") {
        const permMsg = msg as AcpRequest;
        const command = ((permMsg.params?.command as string) ?? "").trim();
        const blockedPatterns = [
          "git push --force",
          "git push -f",
          "git branch -D",
          "gh pr create",
          "gh api",
          "curl ",
          "wget ",
          ".harness/",
        ];
        const blocked = blockedPatterns.some(p => command.includes(p));
        const permResponse = JSON.stringify({
          jsonrpc: "2.0",
          id: permMsg.id,
          result: {
            allowed: !blocked,
            ...(blocked ? { reason: "Blocked by harness guard" } : {}),
          },
        }) + "\n";
        state.tcpSocket.write(permResponse);
        return;
      }

      if (method === "session/update") {
        const notification = msg as AcpNotification;
        const params = notification.params;
        const update = params.update as Record<string, unknown> | undefined;
        const updateType = update?.sessionUpdate as string;

        if (updateType === "agent_message_chunk") {
          this.emitWsEvent(agentId, {
            type: "acp:agent_message_chunk",
            agentId,
            content: update?.content,
          });
          return;
        }

        if (updateType === "tool_call") {
          const toolCallId = update?.toolCallId as string;
          const toolName = (update?.title as string) ?? toolCallId;

          // Start OTEL tool span
          this.toolCallStartTimes.set(`${agentId}:${toolCallId}`, Date.now());
          toolCallCounter.add(1, { "tool.name": toolName, "agent.id": agentId });
          const parentCtx = state.turnSpan
            ? trace.setSpan(context.active(), state.turnSpan)
            : state.sessionSpan
              ? trace.setSpan(context.active(), state.sessionSpan)
              : context.active();
          const toolSpan = tracer.startSpan(`acp_agent.tool.${toolName}`, {
            attributes: { "agent.id": agentId, "tool.name": toolName },
          }, parentCtx);
          state.toolSpans.set(toolCallId, toolSpan);

          this.emitWsEvent(agentId, {
            type: "acp:tool_call",
            agentId,
            toolCallId,
            title: update?.title as string,
            kind: update?.kind as string,
            status: update?.status as string,
            content: update?.content as unknown[] | undefined,
            locations: update?.locations as unknown[] | undefined,
          });
          return;
        }

        if (updateType === "tool_call_update") {
          const toolCallId = update?.toolCallId as string;
          const status = update?.status as string;

          if (status === "completed" || status === "failed") {
            const startKey = `${agentId}:${toolCallId}`;
            const startTime = this.toolCallStartTimes.get(startKey);
            if (startTime !== undefined) {
              toolCallDuration.record(Date.now() - startTime, { "agent.id": agentId });
              this.toolCallStartTimes.delete(startKey);
            }
            const toolSpan = state.toolSpans.get(toolCallId);
            if (toolSpan) {
              if (status === "failed") {
                toolSpan.setStatus({ code: SpanStatusCode.ERROR });
              } else {
                toolSpan.setStatus({ code: SpanStatusCode.OK });
              }
              toolSpan.end();
              state.toolSpans.delete(toolCallId);
            }
          }

          this.emitWsEvent(agentId, {
            type: "acp:tool_call_update",
            agentId,
            toolCallId,
            status,
            content: update?.content as unknown[] | undefined,
            locations: update?.locations as unknown[] | undefined,
          });
          return;
        }

        if (updateType === "plan") {
          this.emitWsEvent(agentId, {
            type: "acp:plan",
            agentId,
            items: (update?.items as unknown[]) ?? [],
          });
          return;
        }

        console.log(`[AcpAgentManager] unhandled session/update type="${updateType}" for ${agentId}`);
        return;
      }

      console.log(`[AcpAgentManager] unhandled notification method="${method}" for ${agentId}`);
    }
  }

  private async sendRequest(
    state: AgentState,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<AcpResponse> {
    const id = state.nextRequestId++;
    const req: AcpRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };

    return new Promise<AcpResponse>((resolve, reject) => {
      const timeoutSec = Math.round(timeoutMs / 1000);
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(id);
        reject(new Error(`[AcpAgentManager] request ${method} (id=${id}) timed out after ${timeoutSec}s`));
      }, timeoutMs);

      state.pendingRequests.set(id, {
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      state.tcpSocket.write(JSON.stringify(req) + "\n");
    });
  }

  /** Connect to the ACP TCP server with exponential backoff retry. */
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
          throw new Error(`[AcpAgentManager] TCP connect to ${host}:${port} timed out after ${maxWaitMs}ms`);
        }
        // Exponential backoff: 500ms, 1s, 2s, 4s, cap at 5s
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 5000);
        if (attempt % 10 === 0) {
          console.log(`[AcpAgentManager] still waiting for TCP (${host}:${port}, ${Math.round(elapsed / 1000)}s elapsed)...`);
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private emitWsEvent(agentId: string, event: WsAcpEvent): void {
    for (const handler of this.agents.get(agentId)?.outputHandlers ?? []) {
      try { handler(event); } catch { /* ignore handler errors */ }
    }
    this.emit(agentId, event);
    const { type, ...payload } = event;
    void appendEvent(agentId, { type, payload: payload as Record<string, unknown>, timestamp: new Date().toISOString() });
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
    agentId: string,
    name: string,
    agentType: string,
    env?: string[],
  ): Promise<string> {
    const image = agentImage(agentType);
    const container = await this.docker.createContainer({
      Image: image,
      name,
      Env: env ?? [],
      HostConfig: {
        NetworkMode: config.subAgentNetwork,
      },
      Labels: { "harness.agent-id": agentId },
    });
    console.log(`[AcpAgentManager] created container ${container.id} name=${name} image=${image}`);
    return container.id;
  }
}
