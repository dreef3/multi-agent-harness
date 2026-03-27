import type Dockerode from "dockerode";
import { config } from "../config.js";

// All provider API key env vars supported by pi-coding-agent
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "OPENCODE_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  // Git / VCS credentials intentionally excluded — sub-agent gets GIT_PUSH_URL instead
  // Cloud providers
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
];

export interface ContainerCreateOptions {
  sessionId: string;
  repoCloneUrl: string;
  /** Authenticated push URL (token embedded). Used by runner.mjs for push; deleted from env before agent starts. */
  gitPushUrl?: string;
  branchName: string;
  taskDescription?: string;
  taskName?: string;
  agentProvider?: string;
  agentModel?: string;
  taskId?: string;
}

export async function createSubAgentContainer(docker: Dockerode, opts: ContainerCreateOptions): Promise<string> {
  const providerEnv = PROVIDER_ENV_VARS
    .filter(name => process.env[name])
    .map(name => `${name}=${process.env[name]}`);

  const agentProvider = opts.agentProvider ?? config.agentProvider;
  const agentModel = opts.agentModel ?? config.implementationModel;

  const taskEnv = [
    ...(opts.taskDescription ? [`TASK_DESCRIPTION=${opts.taskDescription}`] : []),
    ...(opts.gitPushUrl ? [`GIT_PUSH_URL=${opts.gitPushUrl}`] : []),
    `AGENT_PROVIDER=${agentProvider}`,
    `AGENT_MODEL=${agentModel}`,
    `TASK_ID=${opts.taskId ?? ""}`,
    `HARNESS_API_URL=${config.harnessApiUrl}`,
    `AGENT_SESSION_ID=${opts.sessionId}`,
  ];

  const presentProviderKeys = PROVIDER_ENV_VARS.filter(name => process.env[name]);

  console.log(`[containerManager] Creating container for session=${opts.sessionId} taskId=${opts.taskId ?? "n/a"}`);
  console.log(`[containerManager]   image=${config.subAgentImage}`);
  console.log(`[containerManager]   network=${config.subAgentNetwork}`);
  console.log(`[containerManager]   piAgentVolume=${config.piAgentVolume}`);
  console.log(`[containerManager]   branch=${opts.branchName}`);
  console.log(`[containerManager]   agentProvider=${agentProvider} agentModel=${agentModel}`);
  console.log(`[containerManager]   providerEnvVars present: [${presentProviderKeys.join(", ")}]`);
  console.log(`[containerManager]   memory=${config.subAgentMemoryBytes} cpuCount=${config.subAgentCpuCount}`);

  const nameSuffix = opts.taskName
    ? `${opts.taskName}-${(opts.taskId ?? opts.sessionId).slice(0, 8)}`
    : (opts.taskId ?? opts.sessionId).slice(0, 16);
  const containerName = `sub-${nameSuffix}`;

  const container = await docker.createContainer({
    Image: config.subAgentImage,
    name: containerName,
    Env: [`REPO_CLONE_URL=${opts.repoCloneUrl}`, `BRANCH_NAME=${opts.branchName}`, ...taskEnv, ...providerEnv],
    WorkingDir: "/workspace",
    HostConfig: {
      Binds: [
        // Shared pi-agent dir so sub-agents can use OAuth tokens (e.g. GitHub Copilot)
        // logged in via the master agent
        `${config.piAgentVolume}:/pi-agent`,
      ],
      Memory: config.subAgentMemoryBytes,
      NanoCpus: config.subAgentCpuCount * 1_000_000_000,
      NetworkMode: config.subAgentNetwork,
    },
    Labels: { "harness.session-id": opts.sessionId },
  });
  console.log(`[containerManager] Container created: id=${container.id}`);
  return container.id;
}

export async function startContainer(docker: Dockerode, containerId: string): Promise<void> {
  console.log(`[containerManager] Starting container ${containerId}`);
  await docker.getContainer(containerId).start();
  console.log(`[containerManager] Container ${containerId} started`);
}

export async function stopContainer(docker: Dockerode, containerId: string): Promise<void> {
  console.log(`[containerManager] Stopping container ${containerId}`);
  await docker.getContainer(containerId).stop({ t: 10 });
  console.log(`[containerManager] Container ${containerId} stopped`);
}

export async function removeContainer(docker: Dockerode, containerId: string): Promise<void> {
  console.log(`[containerManager] Removing container ${containerId}`);
  await docker.getContainer(containerId).remove({ force: true });
  console.log(`[containerManager] Container ${containerId} removed`);
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
