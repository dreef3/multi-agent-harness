import { EventEmitter } from "events";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import path from "path";
import { config } from "../config.js";
import { existsSync } from "fs";

interface PiEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
}

export class MasterAgent extends EventEmitter {
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

  constructor(
    private readonly projectId: string,
    private readonly sessionFilePath: string,
    private readonly customTools: ToolDefinition[] = [],
    private readonly workingDir?: string
  ) {
    super();
  }

  async init(): Promise<void> {
    console.log(`[MasterAgent:${this.projectId}] init() start`);
    const sessionDir = path.dirname(this.sessionFilePath);
    const settingsManager = SettingsManager.inMemory();

    const superpowersSkillsPaths = this.findSuperpowersSkills();

    const resourceLoader = new DefaultResourceLoader({
      settingsManager,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: superpowersSkillsPaths,
    });

    console.log(`[MasterAgent:${this.projectId}] loading resources...`);
    await resourceLoader.reload();

    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);
    const provider = config.agentProvider;
    const providerModels = config.models[provider as keyof typeof config.models];
    const modelId = providerModels?.masterAgent?.model;
    const model = modelId ? modelRegistry.find(provider, modelId) : undefined;
    console.log(`[MasterAgent:${this.projectId}] provider=${provider} modelId=${modelId} modelFound=${!!model}`);

    console.log(`[MasterAgent:${this.projectId}] creating agent session...`);
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(this.workingDir ?? sessionDir, sessionDir),
      settingsManager,
      resourceLoader,
      modelRegistry,
      ...(model ? { model } : {}),
      ...(this.customTools.length > 0 ? { customTools: this.customTools } : {}),
    });
    console.log(`[MasterAgent:${this.projectId}] session created`);

    session.subscribe((event: unknown) => {
      const e = event as PiEvent;
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) {
        this.emit("delta", e.assistantMessageEvent.delta);
      }
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "message_stop") {
        console.log(`[MasterAgent:${this.projectId}] message_stop received`);
        this.emit("message_complete");
      }
      if (e.type === "tool_execution_start") {
        this.emit("tool_call", (e as { toolName?: string; args?: unknown }).toolName ?? "unknown", (e as { args?: unknown }).args);
      }
      if (e.type === "error") {
        console.error(`[MasterAgent:${this.projectId}] session error event:`, e);
      }
    });
    this.session = session;
    console.log(`[MasterAgent:${this.projectId}] init() complete`);
  }

  private findSuperpowersSkills(): string[] {
    const possiblePaths = [
      path.join(process.cwd(), "node_modules", "superpowers", "skills"),
      path.join(process.env.HOME || "", ".local", "share", "npm", "node_modules", "superpowers", "skills"),
      path.join(process.env.HOME || "", ".bun", "install", "global", "node_modules", "superpowers", "skills"),
    ];
    const skillPaths: string[] = [];
    for (const p of possiblePaths) {
      if (existsSync(p)) skillPaths.push(p);
    }
    if (skillPaths.length === 0) {
      console.warn("[MasterAgent] No superpowers skills directory found. Skills may not be available.");
    }
    return skillPaths;
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("MasterAgent not initialized");
    console.log(`[MasterAgent:${this.projectId}] prompt() called, text length=${text.length}`);
    try {
      await this.session.prompt(text);
      console.log(`[MasterAgent:${this.projectId}] prompt() resolved`);
    } catch (err) {
      console.error(`[MasterAgent:${this.projectId}] prompt() threw:`, err);
      throw err;
    }
  }

  async steer(text: string): Promise<void> {
    if (!this.session) throw new Error("MasterAgent not initialized");
    await this.session.steer(text);
  }

  dispose(): void {
    this.session?.dispose();
    this.session = null;
  }
}
