type MessageHandler = (data: unknown) => void;
type ConnectHandler = () => void;
type DisconnectHandler = () => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private disconnectHandlers: DisconnectHandler[] = [];
  private reconnectInterval = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl: string;
  private projectId: string | null = null;
  private messageQueue: unknown[] = [];

  constructor(baseUrl: string = "/ws") {
    this.baseUrl = baseUrl;
  }

  setProjectId(projectId: string | null): void {
    this.projectId = projectId;
    this.messageQueue = [];
  }

  private getUrl(): string {
    if (this.projectId) {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      return `${protocol}://${window.location.host}/ws/projects/${this.projectId}/chat`;
    }
    return this.baseUrl;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.getUrl());

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      this.connectHandlers.forEach((handler) => handler());
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      while (this.messageQueue.length > 0) {
        this.ws!.send(JSON.stringify(this.messageQueue.shift()));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.messageHandlers.forEach((handler) => handler(data));
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    this.ws.onclose = () => {
      console.log("WebSocket disconnected");
      this.disconnectHandlers.forEach((handler) => handler());
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      this.messageQueue.push(data);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.push(handler);
    return () => {
      this.connectHandlers = this.connectHandlers.filter((h) => h !== handler);
    };
  }

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const wsClient = new WebSocketClient();
export default WebSocketClient;
