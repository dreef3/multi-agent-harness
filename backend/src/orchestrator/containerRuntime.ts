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
  createContainer(spec: AgentContainerSpec): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(containerId: string, force?: boolean): Promise<void>;
  getStatus(containerId: string): Promise<"running" | "stopped" | "exited" | "unknown">;
  watchExit(containerId: string, onExit: (exitCode: number) => void): Promise<void>;
  streamLogs(
    containerId: string,
    onData: (line: string, isError: boolean) => void,
    follow?: boolean
  ): Promise<void>;
  listByLabel(labelKey: string, labelValue: string): Promise<Array<{ id: string; name: string; status: string }>>;
}
