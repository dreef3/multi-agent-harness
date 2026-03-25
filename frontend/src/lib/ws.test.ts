import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocketClient from './ws';

// Track WebSocket constructor calls
const wsConstructorCalls: string[] = [];
let mockWsInstance: {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
};

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readyState = WebSocket.CONNECTING;

  constructor(url: string) {
    wsConstructorCalls.push(url);
    mockWsInstance = this;
  }

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
}

describe('WebSocketClient', () => {
  beforeEach(() => {
    wsConstructorCalls.length = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    // jsdom window.location defaults to http://localhost/
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:5173' },
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('WS URL construction', () => {
    it('uses ?projectId= query param (not a path segment)', () => {
      const client = new WebSocketClient('/ws');
      client.setProjectId('test-project-123');
      client.connect();

      expect(wsConstructorCalls).toHaveLength(1);
      const url = wsConstructorCalls[0];
      expect(url).toContain('?projectId=test-project-123');
      expect(url).not.toMatch(/\/ws\/projects\//);
    });

    it('connects to /ws?projectId=<id> on the same host', () => {
      const client = new WebSocketClient('/ws');
      client.setProjectId('abc-def-456');
      client.connect();

      expect(wsConstructorCalls[0]).toBe('ws://localhost:5173/ws?projectId=abc-def-456');
    });

    it('uses wss:// when page is served over HTTPS', () => {
      Object.defineProperty(window, 'location', {
        value: { protocol: 'https:', host: 'app.example.com' },
        writable: true,
      });

      const client = new WebSocketClient('/ws');
      client.setProjectId('my-project');
      client.connect();

      expect(wsConstructorCalls[0]).toBe('wss://app.example.com/ws?projectId=my-project');
    });

    it('falls back to base URL when no projectId is set', () => {
      const client = new WebSocketClient('/ws');
      client.connect();

      expect(wsConstructorCalls[0]).toBe('/ws');
    });
  });
});
