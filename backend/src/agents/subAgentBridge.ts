import { EventEmitter } from "events";
import type Dockerode from "dockerode";

export interface RpcMessage { type: string; [key: string]: unknown; }

export class SubAgentBridge extends EventEmitter {
  private stream: NodeJS.ReadWriteStream | null = null;
  private buffer = "";

  async attach(docker: Dockerode, containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    this.stream = (await container.attach({ stream: true, stdin: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadWriteStream;
    this.stream.on("data", (chunk: Buffer) => { this.buffer += chunk.toString("utf8"); this.flushBuffer(); });
    this.stream.on("error", (err: Error) => this.emit("error", err));
    this.stream.on("end", () => this.emit("end"));
  }

  send(message: RpcMessage): void {
    if (!this.stream) throw new Error("SubAgentBridge is not attached to a container");
    this.stream.write(JSON.stringify(message) + "\n");
  }

  detach(): void {
    (this.stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    this.stream = null;
    this.buffer = "";
  }

  private flushBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { this.emit("message", JSON.parse(trimmed) as RpcMessage); }
      catch { this.emit("output", trimmed); }
    }
  }
}
