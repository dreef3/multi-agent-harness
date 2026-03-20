import type Dockerode from "dockerode";
import { config } from "../config.js";

export interface ContainerCreateOptions {
  sessionId: string;
  repoCloneUrl: string;
  branchName: string;
  anthropicApiKeyPath: string;
}

export async function createSubAgentContainer(docker: Dockerode, opts: ContainerCreateOptions): Promise<string> {
  const container = await docker.createContainer({
    Image: config.subAgentImage,
    Env: [`REPO_CLONE_URL=${opts.repoCloneUrl}`, `BRANCH_NAME=${opts.branchName}`],
    WorkingDir: "/workspace",
    HostConfig: {
      Binds: [`${opts.anthropicApiKeyPath}:/run/secrets/api-key:ro`],
      Memory: config.subAgentMemoryBytes,
      NanoCpus: config.subAgentCpuCount * 1_000_000_000,
      NetworkMode: config.subAgentNetwork,
    },
    Labels: { "harness.session-id": opts.sessionId },
  });
  return container.id;
}

export async function startContainer(docker: Dockerode, containerId: string): Promise<void> {
  await docker.getContainer(containerId).start();
}

export async function stopContainer(docker: Dockerode, containerId: string): Promise<void> {
  await docker.getContainer(containerId).stop({ t: 10 });
}

export async function removeContainer(docker: Dockerode, containerId: string): Promise<void> {
  await docker.getContainer(containerId).remove({ force: true });
}

export async function getContainerStatus(docker: Dockerode, containerId: string): Promise<"running" | "stopped" | "exited" | "unknown"> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    if (info.State.Status === "running") return "running";
    if (info.State.Status === "exited") return "exited";
    return "stopped";
  } catch { return "unknown"; }
}

export async function watchContainerExit(docker: Dockerode, containerId: string, onExit: (exitCode: number) => void): Promise<void> {
  const events = await docker.getEvents({ filters: JSON.stringify({ container: [containerId], event: ["die"] }) });
  (events as NodeJS.EventEmitter).on("data", (data: Buffer) => {
    const event = JSON.parse(data.toString()) as { Actor?: { Attributes?: { exitCode?: string } } };
    onExit(parseInt(event.Actor?.Attributes?.exitCode ?? "1", 10));
  });
}
