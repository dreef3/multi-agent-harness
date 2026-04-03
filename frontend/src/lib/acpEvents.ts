export type WsAcpEvent =
  | { type: "acp:agent_message_chunk"; agentId: string; content: { type: string; text?: string } }
  | { type: "acp:tool_call"; agentId: string; toolCallId: string; title: string; kind: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:tool_call_update"; agentId: string; toolCallId: string; status: string; content?: unknown[]; locations?: unknown[] }
  | { type: "acp:plan"; agentId: string; items: Array<{ title: string; status: string }> }
  | { type: "acp:turn_complete"; agentId: string; stopReason: string }
  | { type: "acp:error"; agentId: string; message: string }
  | { type: "agent:started"; agentId: string }
  | { type: "agent:stopped"; agentId: string }
  | { type: "agent:crashed"; agentId: string; message: string }
  // Legacy events still used for sub-agent activity
  | { type: "agent_activity"; sessionId: string; event: unknown }
  | { type: "stuck_agent"; sessionId: string }
  | { type: "replay"; messages: unknown[] }
  | { type: "error"; message: string };

export function isAcpEvent(msg: { type: string }): boolean {
  return msg.type.startsWith("acp:") || msg.type.startsWith("agent:");
}
