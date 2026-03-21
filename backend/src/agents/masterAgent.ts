import { EventEmitter } from "events";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import path from "path";
import { config } from "../config.js";
import { existsSync } from "fs";

interface PiEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
}

export class MasterAgent extends EventEmitter {
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;

  constructor(private readonly projectId: string, private readonly sessionFilePath: string) {
    super();
  }

  async init(): Promise<void> {
    const sessionDir = path.dirname(this.sessionFilePath);
    const settingsManager = SettingsManager.inMemory();
    
    // Find superpowers skills directory
    const superpowersSkillsPaths = this.findSuperpowersSkills();
    
    const resourceLoader = new DefaultResourceLoader({
      settingsManager,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: superpowersSkillsPaths,
    });
    
    // Reload to discover skills
    await resourceLoader.reload();
    
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);
    const provider = config.agentProvider;
    const providerModels = config.models[provider as keyof typeof config.models];
    const modelId = providerModels?.masterAgent?.model;
    const model = modelId ? modelRegistry.find(provider, modelId) : undefined;
    
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(sessionDir, sessionDir),
      settingsManager,
      resourceLoader,
      modelRegistry,
      ...(model ? { model } : {}),
    });
    
    session.subscribe((event: unknown) => {
      const e = event as PiEvent;
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) {
        this.emit("delta", e.assistantMessageEvent.delta);
      }
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "message_stop") {
        this.emit("message_complete");
      }
    });
    this.session = session;
  }

  private findSuperpowersSkills(): string[] {
    const possiblePaths = [
      // Installed in node_modules
      path.join(process.cwd(), "node_modules", "superpowers", "skills"),
      // Global install
      path.join(process.env.HOME || "", ".local", "share", "npm", "node_modules", "superpowers", "skills"),
      // Bun global install
      path.join(process.env.HOME || "", ".bun", "install", "global", "node_modules", "superpowers", "skills"),
    ];
    
    const skillPaths: string[] = [];
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        skillPaths.push(p);
      }
    }
    
    if (skillPaths.length === 0) {
      console.warn("[MasterAgent] No superpowers skills directory found. Skills may not be available.");
    }
    
    return skillPaths;
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("MasterAgent not initialized");
    await this.session.prompt(text);
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
