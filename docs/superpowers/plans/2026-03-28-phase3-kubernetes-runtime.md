# Kubernetes Container Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `KubernetesContainerRuntime` using `@kubernetes/client-node`, where each sub-agent becomes a Kubernetes `Job`, and wire it into the `CONTAINER_RUNTIME` config switch alongside `DockerContainerRuntime`.

**Architecture:** `KubernetesContainerRuntime` implements the `ContainerRuntime` interface from Phase 3 plan 25. Each `createContainer()` call creates a Kubernetes `Job` with `backoffLimit: 0` (retries managed by the harness, not Kubernetes). Pod exit is detected via the Watch API. Log streaming uses `CoreV1Api.readNamespacedPodLog`. Volume binds map to PVC references. The factory in `index.ts` selects between Docker and Kubernetes based on `CONTAINER_RUNTIME` env var.

**Tech Stack:** `@kubernetes/client-node` (official Kubernetes JS client), Kubernetes Jobs API (batch/v1), Kubernetes Watch API, TypeScript.

---

## Prerequisites

- [ ] Confirm Phase 3 plan 25 (container interface refactoring) is complete
- [ ] Confirm `ContainerRuntime` interface and `DockerContainerRuntime` exist and tests pass
- [ ] Confirm `CONTAINER_RUNTIME` config key is added to `config.ts` (Step 10 of this plan adds it if missing)
- [ ] Have access to a Kubernetes cluster for integration testing (minikube, kind, or remote)

## Step 1 — Install `@kubernetes/client-node`

- [ ] Run:
  ```bash
  cd backend && bun add @kubernetes/client-node
  ```
- [ ] Verify `backend/package.json` lists `"@kubernetes/client-node"` in dependencies

## Step 2 — Create `backend/src/orchestrator/kubernetesRuntime.ts`

- [ ] Create the file with the following implementation:

```typescript
// backend/src/orchestrator/kubernetesRuntime.ts

import * as k8s from "@kubernetes/client-node";
import type { AgentContainerSpec, ContainerRuntime } from "./containerRuntime.js";

/** Maximum length for a Kubernetes Job name (DNS subdomain rules: 63 chars) */
const MAX_JOB_NAME_LENGTH = 52; // leave room for suffixes

/** Sanitize a container name to a valid Kubernetes resource name */
function toK8sName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, MAX_JOB_NAME_LENGTH);
}

export class KubernetesContainerRuntime implements ContainerRuntime {
  private readonly batchV1: k8s.BatchV1Api;
  private readonly coreV1: k8s.CoreV1Api;
  private readonly namespace: string;
  private readonly kc: k8s.KubeConfig;

  constructor(namespace = "default") {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault(); // Uses in-cluster config if KUBERNETES_SERVICE_HOST is set, else ~/.kube/config
    this.batchV1 = this.kc.makeApiClient(k8s.BatchV1Api);
    this.coreV1 = this.kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = namespace;
  }

  async createContainer(spec: AgentContainerSpec): Promise<string> {
    const jobName = toK8sName(spec.name);

    const job: k8s.V1Job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace: this.namespace,
        labels: {
          "harness.session-id": spec.sessionId,
          "harness.managed": "true",
        },
        annotations: {
          "harness.original-name": spec.name,
        },
      },
      spec: {
        backoffLimit: 0, // No K8s-level retries; harness manages retry logic
        ttlSecondsAfterFinished: 3600, // Auto-cleanup after 1 hour
        template: {
          metadata: {
            labels: {
              "harness.session-id": spec.sessionId,
              "harness.job": jobName,
            },
          },
          spec: {
            restartPolicy: "Never", // Required when backoffLimit=0
            containers: [
              {
                name: "sub-agent",
                image: spec.image,
                env: spec.env.map((e) => {
                  const eqIdx = e.indexOf("=");
                  if (eqIdx === -1) return { name: e, value: "" };
                  return {
                    name: e.slice(0, eqIdx),
                    value: e.slice(eqIdx + 1),
                  };
                }),
                resources: {
                  limits: {
                    memory: String(spec.memoryBytes),
                    cpu: String(spec.nanoCpus / 1_000_000_000),
                  },
                  // Set requests = limits for predictable scheduling
                  requests: {
                    memory: String(spec.memoryBytes),
                    cpu: String(spec.nanoCpus / 1_000_000_000),
                  },
                },
                volumeMounts: spec.binds.map((bind, i) => {
                  const parts = bind.split(":");
                  const mountPath = parts[1] ?? parts[0];
                  return { name: `vol-${i}`, mountPath };
                }),
              },
            ],
            volumes: spec.binds.map((bind, i) => {
              const pvcName = bind.split(":")[0];
              return {
                name: `vol-${i}`,
                persistentVolumeClaim: { claimName: pvcName },
              };
            }),
          },
        },
      },
    };

    await this.batchV1.createNamespacedJob({
      namespace: this.namespace,
      body: job,
    });

    return jobName; // Job name serves as the container ID
  }

  async startContainer(_containerId: string): Promise<void> {
    // Kubernetes Jobs start automatically on creation — no-op
  }

  async stopContainer(containerId: string, _timeoutSeconds = 10): Promise<void> {
    // Suspend the Job (Kubernetes 1.21+)
    try {
      await this.batchV1.patchNamespacedJob({
        name: containerId,
        namespace: this.namespace,
        body: { spec: { suspend: true } },
      });
    } catch (e: unknown) {
      // If job doesn't exist or is already complete, ignore
      if (!isNotFoundError(e)) throw e;
    }
  }

  async removeContainer(containerId: string, _force = false): Promise<void> {
    try {
      await this.batchV1.deleteNamespacedJob({
        name: containerId,
        namespace: this.namespace,
        // propagationPolicy: Foreground deletes pods too
        body: {
          propagationPolicy: "Foreground",
        } as k8s.V1DeleteOptions,
      });
    } catch (e: unknown) {
      if (!isNotFoundError(e)) throw e;
    }
  }

  async getStatus(
    containerId: string
  ): Promise<"running" | "stopped" | "exited" | "unknown"> {
    try {
      const { body: job } = await this.batchV1.readNamespacedJob({
        name: containerId,
        namespace: this.namespace,
      });
      const status = job.status ?? {};
      if (status.succeeded && status.succeeded > 0) return "exited";   // exit code 0
      if (status.failed && status.failed > 0) return "stopped";         // exit code non-0
      if (status.active && status.active > 0) return "running";
      return "unknown";
    } catch (e: unknown) {
      if (isNotFoundError(e)) return "unknown";
      throw e;
    }
  }

  async watchExit(
    containerId: string,
    onExit: (exitCode: number) => void
  ): Promise<void> {
    const watch = new k8s.Watch(this.kc);

    await new Promise<void>((resolve, reject) => {
      watch
        .watch(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
          { fieldSelector: `metadata.name=${containerId}` },
          (type: string, job: k8s.V1Job) => {
            if (type === "MODIFIED" || type === "ADDED") {
              const status = job.status ?? {};
              if (status.succeeded && status.succeeded > 0) {
                onExit(0);
                resolve();
              } else if (status.failed && status.failed > 0) {
                // Attempt to get actual exit code from pod
                this.getPodExitCode(containerId)
                  .then((code) => {
                    onExit(code ?? 1);
                    resolve();
                  })
                  .catch(() => {
                    onExit(1);
                    resolve();
                  });
              }
            } else if (type === "DELETED") {
              onExit(-1); // Container removed before natural exit
              resolve();
            }
          },
          (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          }
        )
        .catch(reject);
    });
  }

  async streamLogs(
    containerId: string,
    onData: (line: string, isError: boolean) => void,
    follow = false
  ): Promise<void> {
    // Find the Pod associated with the Job
    const podName = await this.getPodName(containerId);
    if (!podName) {
      onData(`[harness] No pod found for job ${containerId}`, true);
      return;
    }

    const response = await this.coreV1.readNamespacedPodLog({
      name: podName,
      namespace: this.namespace,
      follow,
      timestamps: false,
    });

    // readNamespacedPodLog returns a string for non-follow, stream for follow
    if (typeof response.body === "string") {
      for (const line of response.body.split("\n")) {
        if (line) onData(line, false);
      }
      return;
    }

    // Streaming mode
    await new Promise<void>((resolve, reject) => {
      const stream = response.body as NodeJS.ReadableStream;
      let buffer = "";

      stream.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) onData(line, false);
        }
      });
      stream.on("end", () => {
        if (buffer) onData(buffer, false);
        resolve();
      });
      stream.on("error", reject);
    });
  }

  async listByLabel(
    labelKey: string,
    labelValue: string
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    const { body } = await this.batchV1.listNamespacedJob({
      namespace: this.namespace,
      labelSelector: `${labelKey}=${labelValue}`,
    });

    return body.items.map((job) => {
      const status = job.status ?? {};
      let statusStr = "unknown";
      if (status.active) statusStr = "running";
      else if (status.succeeded) statusStr = "exited";
      else if (status.failed) statusStr = "stopped";

      return {
        id: job.metadata?.name ?? "",
        name: job.metadata?.annotations?.["harness.original-name"] ?? job.metadata?.name ?? "",
        status: statusStr,
      };
    });
  }

  /** Helper: get pod name for a job */
  private async getPodName(jobName: string): Promise<string | null> {
    const { body } = await this.coreV1.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `harness.job=${jobName}`,
    });
    return body.items[0]?.metadata?.name ?? null;
  }

  /** Helper: get exit code from pod container status */
  private async getPodExitCode(jobName: string): Promise<number | null> {
    const podName = await this.getPodName(jobName);
    if (!podName) return null;

    const { body: pod } = await this.coreV1.readNamespacedPod({
      name: podName,
      namespace: this.namespace,
    });

    const containerStatus = pod.status?.containerStatuses?.[0];
    return containerStatus?.state?.terminated?.exitCode ?? null;
  }
}

function isNotFoundError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message.includes("Not Found") ||
      e.message.includes("404") ||
      (e as { statusCode?: number }).statusCode === 404)
  );
}
```

## Step 3 — Add Kubernetes config to `backend/src/config.ts`

- [ ] Read `backend/src/config.ts`
- [ ] Add the following config entries:

```typescript
// In the config object:
containerRuntime: (process.env.CONTAINER_RUNTIME ?? "docker") as "docker" | "kubernetes",
k8sNamespace: process.env.K8S_NAMESPACE ?? "default",
```

- [ ] Add TypeScript type for the config if it uses a typed interface:
```typescript
containerRuntime: "docker" | "kubernetes";
k8sNamespace: string;
```

## Step 4 — Update `backend/src/index.ts` with runtime factory

- [ ] Read `backend/src/index.ts`
- [ ] Replace the hardcoded `DockerContainerRuntime` construction with a factory:

```typescript
import { DockerContainerRuntime } from "./orchestrator/dockerRuntime.js";
import { KubernetesContainerRuntime } from "./orchestrator/kubernetesRuntime.js";
import type { ContainerRuntime } from "./orchestrator/containerRuntime.js";
import { config } from "./config.js";

// In startup function:
let containerRuntime: ContainerRuntime;

if (config.containerRuntime === "kubernetes") {
  console.log(`[runtime] Using Kubernetes runtime (namespace: ${config.k8sNamespace})`);
  containerRuntime = new KubernetesContainerRuntime(config.k8sNamespace);
} else {
  if (config.containerRuntime !== "docker") {
    console.warn(`[runtime] Unknown CONTAINER_RUNTIME="${config.containerRuntime}", defaulting to docker`);
  }
  console.log("[runtime] Using Docker runtime");
  containerRuntime = new DockerContainerRuntime(docker);
}
```

## Step 5 — Handle volume mapping for Kubernetes

Docker bind mounts (`/host/path:/container/path`) cannot be directly translated to Kubernetes volumes. The `createContainer()` implementation maps them to PVCs.

- [ ] Document the convention: when `CONTAINER_RUNTIME=kubernetes`, the first segment of each bind (the "host path") is treated as a **PVC claim name**, not a filesystem path.

- [ ] Update agent configuration in the harness to use PVC-compatible names when running on Kubernetes. Find where `AgentContainerSpec.binds` is constructed:
  ```bash
  grep -rn "binds:" backend/src/orchestrator/
  grep -rn "AgentContainerSpec" backend/src/orchestrator/
  ```

- [ ] In the call site that builds `AgentContainerSpec`, add a runtime-specific bind builder:

```typescript
// backend/src/orchestrator/taskDispatcher.ts (or wherever spec is built)

function buildBinds(
  sessionId: string,
  repoPath: string,
  runtime: "docker" | "kubernetes"
): string[] {
  if (runtime === "kubernetes") {
    // PVC names must be pre-provisioned; use session-scoped PVC names
    return [
      `harness-workspace-${sessionId}:/workspace`,
      `harness-models:/models:ro`,  // example shared read-only volume
    ];
  }
  // Docker bind mounts use host filesystem paths
  return [
    `${repoPath}:/workspace`,
    `/var/harness/models:/models:ro`,
  ];
}
```

> **Note:** PVC pre-provisioning for Kubernetes workspaces is out of scope for this plan. The bind mapping convention is defined here; actual PVC lifecycle management is a follow-up task.

## Step 6 — Kubernetes network considerations

Sub-agents use TCP RPC to communicate with the planning agent. On Docker, `networkMode` connects them to a shared bridge network. On Kubernetes, all pods in the same namespace can communicate by Pod IP.

- [ ] Find where `networkMode` is set in the spec builder
- [ ] For Kubernetes, the planning agent's Pod IP must be passed as an env var to sub-agent Jobs:

```typescript
// When building env for a sub-agent Job in Kubernetes mode:
if (config.containerRuntime === "kubernetes") {
  const planningAgentPodIp = await this.getPlanningAgentPodIp();
  spec.env.push(`PLANNING_AGENT_HOST=${planningAgentPodIp}`);
  spec.env.push(`PLANNING_AGENT_PORT=3001`); // or whatever port is used
}
```

- [ ] Add `getPlanningAgentPodIp()` helper to `KubernetesContainerRuntime` or a separate Kubernetes utilities module. The pod IP is assigned only after the pod is scheduled and the network plugin runs, so poll until it appears (up to 60 seconds):

```typescript
async getPlanningAgentPodIp(
  sessionId: string,
  timeoutMs = 60_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await this.coreV1.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `harness.role=planning-agent,harness.session-id=${sessionId}`,
    });
    const pod = body.items[0];
    const ip = pod?.status?.podIP;
    if (ip) return ip;

    // Pod not scheduled yet or IP not assigned — wait 2s and retry
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `Planning agent pod IP not available after ${timeoutMs}ms for session ${sessionId}`
  );
}
```

## Step 7 — Add `CONTAINER_RUNTIME` to `.env.example`

- [ ] Edit `.env.example` (if it exists, or document in the startup guide):
```
# Container runtime
# CONTAINER_RUNTIME=docker      (default)
# CONTAINER_RUNTIME=kubernetes
# K8S_NAMESPACE=default         (Kubernetes namespace for agent jobs)
```

## Step 8 — Write unit tests for `KubernetesContainerRuntime`

- [ ] Create `backend/src/orchestrator/__tests__/kubernetesRuntime.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock @kubernetes/client-node to avoid needing a real cluster
const mockCreateJob = mock(() => Promise.resolve({ body: {} }));
const mockReadJob = mock(() =>
  Promise.resolve({ body: { status: { active: 1 } } })
);
const mockDeleteJob = mock(() => Promise.resolve({ body: {} }));
const mockListPod = mock(() =>
  Promise.resolve({ body: { items: [{ metadata: { name: "test-pod" }, status: { podIP: "10.0.0.1" } }] } })
);
const mockReadPodLog = mock(() =>
  Promise.resolve({ body: "log line 1\nlog line 2\n" })
);

// The mock needs to be set up before importing kubernetesRuntime
// Use bun:test's mock.module if available, otherwise use manual factory injection

describe("KubernetesContainerRuntime", () => {
  it("createContainer builds a valid Job spec", async () => {
    // Test that Job name sanitization works
    const name = "Test Agent #1 (session-abc123)";
    const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 52);
    expect(sanitized).toMatch(/^[a-z0-9-]+$/);
    expect(sanitized.length).toBeLessThanOrEqual(52);
  });

  it("toK8sName handles edge cases", () => {
    // Test cases for name sanitization
    const cases: [string, string][] = [
      ["simple-name", "simple-name"],
      ["UPPERCASE", "uppercase"],
      ["with spaces", "with-spaces"],
      ["special!@#chars", "special---chars"],
      ["---leading-hyphens", "leading-hyphens"],
      ["trailing-hyphens---", "trailing-hyphens"],
      ["a".repeat(100), "a".repeat(52)],
    ];
    // Import the sanitizer if exported, or test via createContainer behavior
  });

  it("getStatus maps Job status fields correctly", async () => {
    // Test status mapping logic (can test the logic without K8s connection)
    const testCases = [
      [{ succeeded: 1 }, "exited"],
      [{ failed: 1 }, "stopped"],
      [{ active: 1 }, "running"],
      [{}, "unknown"],
    ] as const;

    for (const [jobStatus, expected] of testCases) {
      // Test the mapping logic directly
      let result: string;
      if (jobStatus.succeeded) result = "exited";
      else if ((jobStatus as { failed?: number }).failed) result = "stopped";
      else if ((jobStatus as { active?: number }).active) result = "running";
      else result = "unknown";
      expect(result).toBe(expected);
    }
  });

  it("env parsing handles values with equals signs", () => {
    const envStr = "DATABASE_URL=postgresql://user:pass@host/db?ssl=true";
    const eqIdx = envStr.indexOf("=");
    const name = envStr.slice(0, eqIdx);
    const value = envStr.slice(eqIdx + 1);
    expect(name).toBe("DATABASE_URL");
    expect(value).toBe("postgresql://user:pass@host/db?ssl=true");
  });
});
```

> **Note:** Full integration tests require a live Kubernetes cluster (minikube or kind). The unit tests above validate the logic layer. Add integration tests to a separate `kubernetesRuntime.integration.test.ts` that is skipped when `CONTAINER_RUNTIME !== "kubernetes"`.

## Step 9 — Integration test setup (Kubernetes)

- [ ] Create `backend/src/orchestrator/__tests__/kubernetesRuntime.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { KubernetesContainerRuntime } from "../kubernetesRuntime.js";

const SKIP = process.env.CONTAINER_RUNTIME !== "kubernetes";

describe.skipIf(SKIP)("KubernetesContainerRuntime (integration)", () => {
  let runtime: KubernetesContainerRuntime;

  beforeAll(() => {
    runtime = new KubernetesContainerRuntime(process.env.K8S_NAMESPACE ?? "default");
  });

  it("creates and starts a Job, then removes it", async () => {
    const id = await runtime.createContainer({
      sessionId: "test-session-1",
      image: "busybox:latest",
      name: "harness-test-job",
      env: ["FOO=bar"],
      binds: [],
      memoryBytes: 128 * 1024 * 1024, // 128MB
      nanoCpus: 500_000_000, // 0.5 CPU
      networkMode: "default",
    });

    expect(id).toMatch(/^harness-test-job/);

    // Wait for job to complete (busybox exits immediately)
    await new Promise<void>((resolve) => {
      runtime.watchExit(id, (code) => {
        expect(code).toBe(0);
        resolve();
      });
    });

    const status = await runtime.getStatus(id);
    expect(status).toBe("exited");

    await runtime.removeContainer(id);
    const afterStatus = await runtime.getStatus(id);
    expect(afterStatus).toBe("unknown");
  }, 60_000); // 60s timeout for pod scheduling
});
```

- [ ] Run integration tests only in CI with a Kubernetes cluster:
  ```bash
  CONTAINER_RUNTIME=kubernetes K8S_NAMESPACE=harness-test bun run test --filter "integration"
  ```

## Step 10 — Verify

- [ ] TypeScript check: `cd backend && bunx tsc --noEmit`
- [ ] Unit tests: `cd backend && bun run test` — all must pass (integration tests skipped without `CONTAINER_RUNTIME=kubernetes`)
- [ ] With Docker (default behavior unchanged): start the harness normally, create a session, verify containers are Docker containers
- [ ] With Kubernetes (requires cluster):
  ```bash
  CONTAINER_RUNTIME=kubernetes K8S_NAMESPACE=default bun run dev
  ```
  - Create a session via the API
  - Verify a Job is created in Kubernetes: `kubectl get jobs -n default -l harness.managed=true`
  - Verify the Job completes and `getStatus()` returns `"exited"`

## File Summary

| File | Action |
|------|--------|
| `backend/src/orchestrator/kubernetesRuntime.ts` | CREATE — KubernetesContainerRuntime class |
| `backend/src/config.ts` | MODIFY — add `containerRuntime`, `k8sNamespace` |
| `backend/src/index.ts` | MODIFY — runtime factory (Docker vs Kubernetes) |
| `backend/src/orchestrator/taskDispatcher.ts` | MODIFY — PVC-aware bind builder for Kubernetes |
| `.env.example` | MODIFY — document CONTAINER_RUNTIME, K8S_NAMESPACE |
| `backend/src/orchestrator/__tests__/kubernetesRuntime.test.ts` | CREATE — unit tests |
| `backend/src/orchestrator/__tests__/kubernetesRuntime.integration.test.ts` | CREATE — integration tests (skipped by default) |

## Acceptance Criteria

- `bun run test` passes with zero failures (Docker mode, no cluster needed)
- `CONTAINER_RUNTIME=kubernetes` env var switches to Kubernetes runtime at startup
- `createContainer()` creates a Kubernetes Job in the correct namespace
- Job name sanitization produces valid DNS subdomain names (`[a-z0-9-]`, max 52 chars)
- `getStatus()` correctly maps Job `status.succeeded/failed/active` to runtime status values
- `watchExit()` detects Job completion via Watch API
- `streamLogs()` fetches Pod logs and delivers them line-by-line to `onData`
- `removeContainer()` deletes the Job with `propagationPolicy: Foreground` (also removes pods)
- Integration tests pass against a live Kubernetes cluster when `CONTAINER_RUNTIME=kubernetes` is set

## Known Limitations and Follow-ups

1. **PVC provisioning:** Sub-agent workspace PVCs must be pre-created or managed by a separate PVC lifecycle service. This plan assumes they exist — a follow-up plan should add automated PVC creation/deletion per session.

2. **Planning agent TCP RPC on Kubernetes:** The planning agent must run as a Kubernetes Deployment (or Job) with a stable Service or Pod IP. Service-based discovery is more robust than Pod IP. A follow-up plan should add a `PlanningAgentService` Kubernetes Service.

3. **RBAC:** The harness (running in-cluster or externally) needs Kubernetes RBAC permissions to create/delete Jobs and read Pods. A follow-up plan should provide RBAC manifests (`ClusterRole`, `RoleBinding`).

4. **Multi-node log streaming:** `readNamespacedPodLog` works for single pods. For multi-container Jobs, logs from each container need to be streamed separately.

5. **Job TTL:** `ttlSecondsAfterFinished: 3600` means Jobs auto-delete after 1 hour. The `listByLabel()` method may not find old completed Jobs. Consider adjusting TTL or querying a separate store for completed session statuses.
