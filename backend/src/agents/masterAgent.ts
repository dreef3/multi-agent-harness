import { EventEmitter } from "events";
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import path from "path";
import { config } from "../config.js";

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
    // Use in-memory settings to skip npm package resolution (which makes slow network calls)
    const settingsManager = SettingsManager.inMemory();
    // Pre-build a resource loader without calling reload() to skip all network I/O.
    // createAgentSession only calls reload() when it creates the resource loader itself;
    // if we pass one pre-built, it skips that slow initialization entirely.
    const resourceLoader = new DefaultResourceLoader({
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    // Resolve the model explicitly to skip findInitialModel() network checks.
    // Use provider+model from config so it's configurable per deployment.
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
