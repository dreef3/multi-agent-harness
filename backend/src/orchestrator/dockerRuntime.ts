// backend/src/orchestrator/dockerRuntime.ts

import type Dockerode from "dockerode";
import type { AgentContainerSpec, ContainerRuntime } from "./containerRuntime.js";

/**
 * Parse a Docker multiplexed log stream (8-byte header frames).
 * Docker prepends each log chunk with an 8-byte header:
 *   [stream_type(1), 0, 0, 0, size(4 bytes, big-endian)]
 * Returns decoded lines and whether each came from stderr.
 */
export function parseDockerLogBuffer(buf: Buffer): Array<{ line: string; isError: boolean }> {
  const results: Array<{ line: string; isError: boolean }> = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    const chunk = buf.slice(offset, offset + size).toString();
    offset += size;
    const isError = streamType === 2;
    for (const line of chunk.split("\n")) {
      if (line) results.push({ line, isError });
    }
  }
  return results;
}

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
    await this.docker.getContainer(containerId).start();
  }

  async stopContainer(containerId: string, timeoutSeconds = 10): Promise<void> {
    await this.docker.getContainer(containerId).stop({ t: timeoutSeconds });
  }

  async removeContainer(containerId: string, force = true): Promise<void> {
    await this.docker.getContainer(containerId).remove({ force });
  }

  async getStatus(containerId: string): Promise<"running" | "stopped" | "exited" | "unknown"> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      if (info.State.Status === "running") return "running";
      if (info.State.Status === "exited") return "exited";
      return "stopped";
    } catch {
      return "unknown";
    }
  }

  async watchExit(containerId: string, onExit: (exitCode: number) => void): Promise<void> {
    const events = await this.docker.getEvents({
      filters: JSON.stringify({ container: [containerId], event: ["die"] }),
    });
    const emitter = events as NodeJS.EventEmitter;
    emitter.on("data", (data: Buffer) => {
      const event = JSON.parse(data.toString()) as { Actor?: { Attributes?: { exitCode?: string } } };
      onExit(parseInt(event.Actor?.Attributes?.exitCode ?? "1", 10));
    });
    emitter.on("error", (err: Error) => {
      console.error(`[dockerRuntime] watchExit stream error for ${containerId}:`, err);
    });
    emitter.on("end", () => {
      console.log(`[dockerRuntime] watchExit stream ended for ${containerId}`);
    });
  }

  async streamLogs(
    containerId: string,
    onData: (line: string, isError: boolean) => void,
    follow = true
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.docker.getContainer(containerId).logs as (...args: any[]) => void)(
        { follow, stdout: true, stderr: true, timestamps: false },
        (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
          if (err) { reject(err); return; }
          if (!stream) { resolve(); return; }
          stream.on("data", (chunk: Buffer) => {
            const entries = parseDockerLogBuffer(chunk);
            if (entries.length === 0) {
              // Fallback: raw text (non-multiplexed)
              for (const line of chunk.toString().split("\n")) {
                if (line) onData(line, false);
              }
            } else {
              for (const { line, isError } of entries) {
                onData(line, isError);
              }
            }
          });
          stream.on("end", () => resolve());
          stream.on("error", reject);
        }
      );
    });
  }

  async listByLabel(labelKey: string, labelValue: string): Promise<Array<{ id: string; name: string; status: string }>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${labelKey}=${labelValue}`] }),
    });
    return containers.map(c => ({
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
      status: c.State ?? "unknown",
    }));
  }
}
