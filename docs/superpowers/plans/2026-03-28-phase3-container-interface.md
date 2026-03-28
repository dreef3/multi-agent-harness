# Container Runtime Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a `ContainerRuntime` interface and extract all Dockerode calls from `containerManager.ts` into a `DockerContainerRuntime` class, so future runtimes (Kubernetes) can be plugged in without touching orchestrator logic.

**Architecture:** `containerRuntime.ts` defines the `ContainerRuntime` interface and `AgentContainerSpec` type. `dockerRuntime.ts` implements the interface using Dockerode. `containerManager.ts` becomes a thin module (or is removed) that delegates to a `ContainerRuntime` instance injected at startup. Call sites (`taskDispatcher.ts`, `recoveryService.ts`, `planningAgentManager.ts`) receive the runtime via constructor injection.

**Tech Stack:** TypeScript, `dockerode`, dependency injection (constructor params), existing Bun test runner.

---

## Prerequisites

- [ ] Read `backend/src/orchestrator/containerManager.ts` fully — list every function and its Dockerode API usage
- [ ] Read `backend/src/orchestrator/taskDispatcher.ts` — note where container functions are called
- [ ] Read `backend/src/orchestrator/recoveryService.ts` — note container status calls
- [ ] Read `backend/src/orchestrator/planningAgentManager.ts` — note Docker usage
- [ ] Run `bun run test` from `backend/` — record baseline passing state

## Step 1 — Create `backend/src/orchestrator/containerRuntime.ts`

- [ ] Create the interface file:

```typescript
// backend/src/orchestrator/containerRuntime.ts

/**
 * Specification for creating an agent container.
 * Runtime-agnostic: Docker maps these to container config, Kubernetes to Job spec.
 */
export interface AgentContainerSpec {
  /** Session ID — used for labeling and log correlation */
  sessionId: string;
  /** Container image (e.g., "ghcr.io/org/sub-agent:latest") */
  image: string;
  /** Container/Job name (used for identification and discovery) */
  name: string;
  /** Environment variables in KEY=VALUE format */
  env: string[];
  /**
   * Volume bind mounts in "hostPath:containerPath[:options]" format.
   * For Kubernetes, hostPath is interpreted as PVC claim name.
   */
  binds: string[];
  /** Memory limit in bytes */
  memoryBytes: number;
  /** CPU limit in nanocpus (1 CPU = 1_000_000_000) */
  nanoCpus: number;
  /**
   * Network mode.
   * Docker: "bridge", "host", or "container:<id>".
   * Kubernetes: ignored (uses cluster networking).
   */
  networkMode: string;
}

/**
 * Runtime-agnostic interface for managing agent containers.
 * Implemented by DockerContainerRuntime and KubernetesContainerRuntime.
 */
export interface ContainerRuntime {
  /**
   * Create a container from the given spec.
   * Returns a runtime-specific container/job ID (string).
   * The container is NOT started after this call — call startContainer() next.
   * Exception: some runtimes (Kubernetes Jobs) start automatically on creation;
   * in that case, startContainer() is a no-op.
   */
  createContainer(spec: AgentContainerSpec): Promise<string>;

  /**
   * Start a previously created container.
   * No-op if the runtime starts containers automatically (e.g., Kubernetes Jobs).
   */
  startContainer(containerId: string): Promise<void>;

  /**
   * Stop a running container gracefully.
   * @param timeoutSeconds Seconds to wait before SIGKILL (default: 10)
   */
  stopContainer(containerId: string, timeoutSeconds?: number): Promise<void>;

  /**
   * Remove a container and its associated resources.
   * @param force If true, remove even if still running (default: false)
   */
  removeContainer(containerId: string, force?: boolean): Promise<void>;

  /**
   * Get the current status of a container.
   * "running"  — container is running
   * "stopped"  — container is stopped (not running, exit code non-0 or killed)
   * "exited"   — container exited cleanly (exit code 0)
   * "unknown"  — container not found or status indeterminate
   */
  getStatus(containerId: string): Promise<"running" | "stopped" | "exited" | "unknown">;

  /**
   * Wait for a container to exit, then call onExit with the exit code.
   * Implementations should handle cleanup of the watcher on container removal.
   */
  watchExit(containerId: string, onExit: (exitCode: number) => void): Promise<void>;

  /**
   * Stream container logs.
   * @param onData Called for each log line with the line content and whether it's stderr
   * @param follow If true, stream until container stops (default: false = fetch existing logs)
   */
  streamLogs(
    containerId: string,
    onData: (line: string, isError: boolean) => void,
    follow?: boolean
  ): Promise<void>;

  /**
   * List all containers managed by this runtime that match the given label.
   * Used by recovery service to find orphaned containers after restart.
   */
  listByLabel(labelKey: string, labelValue: string): Promise<Array<{ id: string; name: string; status: string }>>;
}
```

## Step 2 — Audit `containerManager.ts` functions

- [ ] List every exported function from `containerManager.ts` and map to the interface:

| Old function | Maps to |
|-------------|---------|
| `createSubAgentContainer(spec)` | `runtime.createContainer(spec)` |
| `startContainer(id)` | `runtime.startContainer(id)` |
| `stopContainer(id)` | `runtime.stopContainer(id)` |
| `removeContainer(id)` | `runtime.removeContainer(id)` |
| `getContainerStatus(id)` | `runtime.getStatus(id)` |
| `waitForExit(id, cb)` | `runtime.watchExit(id, cb)` |
| `streamContainerLogs(id, cb)` | `runtime.streamLogs(id, cb)` |
| `listContainersByLabel(k, v)` | `runtime.listByLabel(k, v)` |

> Verify the actual function names from reading `containerManager.ts`. The above is a template.

## Step 3 — Create `backend/src/orchestrator/dockerRuntime.ts`

- [ ] Create the Docker implementation by moving all Dockerode logic from `containerManager.ts`:

```typescript
// backend/src/orchestrator/dockerRuntime.ts

import Dockerode from "dockerode";
import type { AgentContainerSpec, ContainerRuntime } from "./containerRuntime.js";

export class DockerContainerRuntime implements ContainerRuntime {
  constructor(private readonly docker: Dockerode) {}

  async createContainer(spec: AgentContainerSpec): Promise<string> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      name: spec.name,
      Env: spec.env,
      HostConfig: {
        Binds: spec.binds,
        Memory: spec.memoryBytes,
        NanoCpus: spec.nanoCpus,
        NetworkMode: spec.networkMode,
      },
      Labels: {
        "harness.session-id": spec.sessionId,
        "harness.managed": "true",
      },
    });
    return container.id;
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async stopContainer(containerId: string, timeoutSeconds = 10): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: timeoutSeconds });
  }

  async removeContainer(containerId: string, force = false): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force });
  }

  async getStatus(
    containerId: string
  ): Promise<"running" | "stopped" | "exited" | "unknown"> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      const state = info.State;
      if (state.Running) return "running";
      if (state.ExitCode === 0 && !state.Running) return "exited";
      if (!state.Running) return "stopped";
      return "unknown";
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("No such container")) {
        return "unknown";
      }
      throw e;
    }
  }

  async watchExit(containerId: string, onExit: (exitCode: number) => void): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const stream = await container.wait();
    onExit(stream.StatusCode);
  }

  async streamLogs(
    containerId: string,
    onData: (line: string, isError: boolean) => void,
    follow = false
  ): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const stream = await container.logs({
      follow,
      stdout: true,
      stderr: true,
      timestamps: false,
    });

    // Dockerode returns a Buffer or stream depending on options
    // Parse the multiplexed stream format (8-byte header per frame)
    if (Buffer.isBuffer(stream)) {
      parseDockerLogBuffer(stream, onData);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      (stream as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        parseDockerLogBuffer(chunk, onData);
      });
      (stream as NodeJS.ReadableStream).on("end", resolve);
      (stream as NodeJS.ReadableStream).on("error", reject);
    });
  }

  async listByLabel(
    labelKey: string,
    labelValue: string
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${labelKey}=${labelValue}`] }),
    });
    return containers.map((c) => ({
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id,
      status: c.State,
    }));
  }
}

/**
 * Parse Docker's multiplexed log stream format.
 * Each frame has an 8-byte header: [stream_type, 0, 0, 0, size_be_4_bytes]
 * stream_type: 1 = stdout, 2 = stderr
 */
function parseDockerLogBuffer(
  buf: Buffer,
  onData: (line: string, isError: boolean) => void
): void {
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 8) break;
    const streamType = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (buf.length - offset < size) break;
    const line = buf.slice(offset, offset + size).toString("utf8").trimEnd();
    offset += size;
    if (line) onData(line, streamType === 2);
  }
}
```

> **Note for implementer:** The exact Dockerode API calls above may differ from what's in `containerManager.ts`. When moving code, preserve the existing Dockerode calls exactly — do not rewrite them from scratch. The goal is to move, not rewrite.

## Step 4 — Update dependency injection in `backend/src/index.ts`

- [ ] Read `backend/src/index.ts` to understand current instantiation pattern
- [ ] Add `DockerContainerRuntime` construction:

```typescript
import Dockerode from "dockerode";
import { DockerContainerRuntime } from "./orchestrator/dockerRuntime.js";
import type { ContainerRuntime } from "./orchestrator/containerRuntime.js";

// In startup:
const docker = new Dockerode(); // or however it's currently constructed
const containerRuntime: ContainerRuntime = new DockerContainerRuntime(docker);
```

- [ ] Pass `containerRuntime` to each consumer that currently uses `containerManager`:
  ```typescript
  const recoveryService = new RecoveryService(containerRuntime, /* other deps */);
  const planningAgentManager = new PlanningAgentManager(containerRuntime, /* other deps */);
  const taskDispatcher = new TaskDispatcher(containerRuntime, /* other deps */);
  ```

## Step 5 — Refactor `taskDispatcher.ts` to use `ContainerRuntime`

- [ ] Read `taskDispatcher.ts`
- [ ] Add `containerRuntime: ContainerRuntime` as a constructor parameter
- [ ] Replace all `import { createSubAgentContainer, ... } from "./containerManager.js"` with the runtime instance
- [ ] Replace each `containerManager.*` call with `this.containerRuntime.*`

Example:
```typescript
// Before:
import { createSubAgentContainer, startContainer } from "./containerManager.js";
// ...
const containerId = await createSubAgentContainer(spec);
await startContainer(containerId);

// After (in constructor):
constructor(private readonly runtime: ContainerRuntime, ...) {}

// In method:
const containerId = await this.runtime.createContainer(spec);
await this.runtime.startContainer(containerId);
```

## Step 6 — Refactor `recoveryService.ts` to use `ContainerRuntime`

- [ ] Read `recoveryService.ts`
- [ ] Add `containerRuntime: ContainerRuntime` as a constructor parameter
- [ ] Replace `getContainerStatus(id)` → `this.runtime.getStatus(id)`
- [ ] Replace `listContainersByLabel(k, v)` → `this.runtime.listByLabel(k, v)`

## Step 7 — Refactor `planningAgentManager.ts` to use `ContainerRuntime`

- [ ] Read `planningAgentManager.ts`
- [ ] Add `containerRuntime: ContainerRuntime` as a constructor parameter
- [ ] Replace Docker calls with runtime interface calls

## Step 8 — Deprecate/remove `containerManager.ts`

- [ ] Check if `containerManager.ts` has any remaining callers:
  ```bash
  grep -rn "containerManager" backend/src/
  ```

- [ ] If all callers have been migrated, delete `containerManager.ts`
- [ ] If some callers remain (e.g., utility functions not in the interface), either:
  - Add them to the interface, OR
  - Keep `containerManager.ts` as a thin legacy shim that delegates to `DockerContainerRuntime`

## Step 9 — Update tests

- [ ] Find existing container manager tests:
  ```bash
  ls backend/src/orchestrator/__tests__/
  # or
  grep -rn "containerManager\|createSubAgentContainer" backend/src/**/*.test.ts
  ```

- [ ] Update test imports from `containerManager` to `dockerRuntime`

- [ ] Add a mock `ContainerRuntime` for unit testing orchestrator logic:

```typescript
// backend/src/orchestrator/__tests__/mocks/mockContainerRuntime.ts

import type { AgentContainerSpec, ContainerRuntime } from "../../containerRuntime.js";

export class MockContainerRuntime implements ContainerRuntime {
  public containers = new Map<string, { spec: AgentContainerSpec; status: string }>();

  async createContainer(spec: AgentContainerSpec): Promise<string> {
    const id = `mock-${Math.random().toString(36).slice(2)}`;
    this.containers.set(id, { spec, status: "created" });
    return id;
  }

  async startContainer(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c) c.status = "running";
  }

  async stopContainer(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c) c.status = "stopped";
  }

  async removeContainer(id: string): Promise<void> {
    this.containers.delete(id);
  }

  async getStatus(id: string): Promise<"running" | "stopped" | "exited" | "unknown"> {
    const c = this.containers.get(id);
    if (!c) return "unknown";
    return c.status as "running" | "stopped" | "exited" | "unknown";
  }

  async watchExit(id: string, onExit: (exitCode: number) => void): Promise<void> {
    // Simulate immediate exit for tests
    setTimeout(() => onExit(0), 0);
  }

  async streamLogs(_id: string, onData: (line: string, isError: boolean) => void): Promise<void> {
    onData("mock log line", false);
  }

  async listByLabel(_key: string, _value: string) {
    return [...this.containers.entries()].map(([id, c]) => ({
      id,
      name: c.spec.name,
      status: c.status,
    }));
  }
}
```

- [ ] Use `MockContainerRuntime` in unit tests for `TaskDispatcher`, `RecoveryService`, and `PlanningAgentManager`

## Step 10 — Verify

- [ ] TypeScript check: `cd backend && bunx tsc --noEmit`
- [ ] Run tests: `cd backend && bun run test`
  - All existing tests must pass
  - New mock-based tests for orchestrators should also pass

## File Summary

| File | Action |
|------|--------|
| `backend/src/orchestrator/containerRuntime.ts` | CREATE — interface + AgentContainerSpec |
| `backend/src/orchestrator/dockerRuntime.ts` | CREATE — DockerContainerRuntime class |
| `backend/src/orchestrator/containerManager.ts` | DELETE (or convert to shim) |
| `backend/src/orchestrator/taskDispatcher.ts` | MODIFY — constructor injection |
| `backend/src/orchestrator/recoveryService.ts` | MODIFY — constructor injection |
| `backend/src/orchestrator/planningAgentManager.ts` | MODIFY — constructor injection |
| `backend/src/index.ts` | MODIFY — construct DockerContainerRuntime, inject |
| `backend/src/orchestrator/__tests__/mocks/mockContainerRuntime.ts` | CREATE |
| Existing test files | MODIFY — update imports, use mock |

## Acceptance Criteria

- `bun run test` passes with zero failures
- `bunx tsc --noEmit` passes with zero errors
- No remaining imports of `containerManager` in non-test source files
- `DockerContainerRuntime` implements all methods of `ContainerRuntime`
- `TaskDispatcher`, `RecoveryService`, `PlanningAgentManager` accept `ContainerRuntime` via constructor
- `MockContainerRuntime` is usable in unit tests without Docker daemon
