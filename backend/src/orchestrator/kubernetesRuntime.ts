// backend/src/orchestrator/kubernetesRuntime.ts

import * as k8s from "@kubernetes/client-node";
import type { IncomingMessage } from "node:http";
import type { AgentContainerSpec, ContainerRuntime } from "./containerRuntime.js";

/** Maximum length for a Kubernetes Job name (DNS subdomain rules: 63 chars) */
const MAX_JOB_NAME_LENGTH = 52; // leave room for suffixes

/** Sanitize a container name to a valid Kubernetes resource name */
export function toK8sName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, MAX_JOB_NAME_LENGTH)
    .replace(/^-+|-+$/g, ""); // trim again after slice
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
    if (!jobName) {
      throw new Error(`[kubernetesRuntime] Cannot derive valid Kubernetes name from: "${spec.name}"`);
    }

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
                // Note: AgentContainerSpec.capDrop, securityOpt, readonlyRootfs, tmpfs, and workingDir
                // are not applied here. The Kubernetes equivalents would be pod/container securityContext
                // fields. Implement securityContext mapping as a follow-up when Kubernetes deployments
                // require security hardening parity with the Docker runtime.
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
        propagationPolicy: "Foreground",
      });
    } catch (e: unknown) {
      if (!isNotFoundError(e)) throw e;
    }
  }

  async getStatus(
    containerId: string
  ): Promise<"running" | "stopped" | "exited" | "unknown"> {
    try {
      const job = await this.batchV1.readNamespacedJob({
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
    let settled = false;

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      onExit(exitCode);
    };

    await new Promise<void>((resolve, reject) => {
      watch
        .watch(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
          { fieldSelector: `metadata.name=${containerId}` },
          (type: string, job: k8s.V1Job) => {
            if (settled) return;
            if (type === "MODIFIED" || type === "ADDED") {
              const status = job.status ?? {};
              if (status.succeeded && status.succeeded > 0) {
                settle(0);
                resolve();
              } else if (status.failed && status.failed > 0) {
                this.getPodExitCode(containerId)
                  .then((code) => {
                    settle(code ?? 1);
                    resolve();
                  })
                  .catch(() => {
                    settle(1);
                    resolve();
                  });
              }
            } else if (type === "DELETED") {
              settle(-1);
              resolve();
            }
          },
          (err: Error | null) => {
            if (err) {
              reject(err);
            } else {
              // Watch connection closed (EOF/reconnect) — poll for final status
              if (!settled) {
                this.getStatus(containerId)
                  .then((status) => {
                    if (status === "exited") {
                      settle(0);
                    } else if (status === "stopped") {
                      settle(1);
                    }
                    // If still running/unknown, don't call onExit — caller must retry watchExit
                    resolve();
                  })
                  .catch(() => resolve());
              } else {
                resolve();
              }
            }
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

    // readNamespacedPodLog returns a string for non-follow mode
    if (typeof response === "string") {
      for (const line of response.split("\n")) {
        if (line) onData(line, false);
      }
      return;
    }

    // Streaming mode
    await new Promise<void>((resolve, reject) => {
      const stream = response as unknown as IncomingMessage;
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
    const jobs = await this.batchV1.listNamespacedJob({
      namespace: this.namespace,
      labelSelector: `${labelKey}=${labelValue}`,
    });

    return jobs.items.map((job) => {
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
    const pods = await this.coreV1.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `harness.job=${jobName}`,
    });
    return pods.items[0]?.metadata?.name ?? null;
  }

  /** Helper: get exit code from pod container status */
  private async getPodExitCode(jobName: string): Promise<number | null> {
    const podName = await this.getPodName(jobName);
    if (!podName) return null;

    const pod = await this.coreV1.readNamespacedPod({
      name: podName,
      namespace: this.namespace,
    });

    const containerStatus = pod.status?.containerStatuses?.[0];
    return containerStatus?.state?.terminated?.exitCode ?? null;
  }
}

function isNotFoundError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message.includes("Not Found") || e.message.includes("404")) return true;
  if ((e as { statusCode?: number }).statusCode === 404) return true;
  // k8s client sometimes wraps the API response in a body property
  const body = (e as { body?: { code?: number; reason?: string } }).body;
  if (body?.code === 404 || body?.reason === "NotFound") return true;
  return false;
}
