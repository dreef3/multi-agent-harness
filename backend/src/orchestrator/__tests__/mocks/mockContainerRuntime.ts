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
