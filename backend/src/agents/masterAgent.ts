import { EventEmitter } from "events";
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import path from "path";

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
    const { session } = await createAgentSession({ sessionManager: SessionManager.create(sessionDir, sessionDir) });
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
