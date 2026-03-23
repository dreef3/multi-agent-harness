import { describe, it, expect } from "vitest";
import type { Message } from "../lib/api";

/**
 * These tests verify the replay message handler logic.
 * The logic is extracted here for unit testing purposes.
 */

// Extracted replay logic that will be used in Chat.tsx
function handleReplayMerge(
  existingMessages: Message[],
  replayedMessages: Message[]
): { merged: Message[]; maxSeqId: number } {
  const existingSeqIds = new Set(existingMessages.map((m) => m.seqId));
  const newFromReplay = replayedMessages.filter((m) => !existingSeqIds.has(m.seqId));

  if (newFromReplay.length === 0) {
    return { merged: existingMessages, maxSeqId: 0 };
  }

  const merged = [...existingMessages, ...newFromReplay].sort(
    (a, b) => (a.seqId ?? 0) - (b.seqId ?? 0)
  );

  const maxSeq =
    replayedMessages.length > 0
      ? replayedMessages.reduce((m, msg) => Math.max(m, msg.seqId ?? 0), 0)
      : 0;

  return { merged, maxSeqId: maxSeq };
}

describe("replay message handler", () => {
  const createMessage = (id: string, seqId: number, content: string, role: "user" | "assistant"): Message => ({
    id,
    projectId: "proj-1",
    role,
    content,
    timestamp: new Date().toISOString(),
    seqId,
  });

  describe("merge behavior", () => {
    it("should merge replay messages with existing messages instead of replacing", () => {
      const existing: Message[] = [
        createMessage("msg-1", 1, "Hello", "user"),
      ];

      const replayed: Message[] = [
        createMessage("msg-2", 2, "Hi there!", "assistant"),
      ];

      const { merged } = handleReplayMerge(existing, replayed);

      // Should contain both existing and replayed messages
      expect(merged).toHaveLength(2);
      expect(merged[0].id).toBe("msg-1");
      expect(merged[1].id).toBe("msg-2");
    });

    it("should replace messages if no new messages are replayed", () => {
      // When replay contains the same messages, merged should be the existing
      const existing: Message[] = [
        createMessage("msg-1", 1, "Hello", "user"),
      ];

      const replayed: Message[] = [
        createMessage("msg-1", 1, "Hello", "user"),
      ];

      const { merged } = handleReplayMerge(existing, replayed);

      // Should return the same existing messages (no duplication)
      expect(merged).toHaveLength(1);
      expect(merged[0].id).toBe("msg-1");
    });
  });

  describe("deduplication by seqId", () => {
    it("should deduplicate messages by seqId", () => {
      const existing: Message[] = [
        createMessage("msg-1", 1, "Hello", "user"),
        createMessage("msg-2", 2, "Second", "user"),
      ];

      const replayed: Message[] = [
        createMessage("msg-1-dup", 1, "Hello duplicate", "user"), // Same seqId
        createMessage("msg-3", 3, "Third", "assistant"),
      ];

      const { merged } = handleReplayMerge(existing, replayed);

      // Should not duplicate seqId 1
      expect(merged).toHaveLength(3);
      const seqIds = merged.map((m) => m.seqId);
      expect(seqIds).toEqual([1, 2, 3]);
    });

    it("should handle empty existing messages", () => {
      const existing: Message[] = [];

      const replayed: Message[] = [
        createMessage("msg-1", 1, "First", "user"),
        createMessage("msg-2", 2, "Second", "assistant"),
      ];

      const { merged } = handleReplayMerge(existing, replayed);

      expect(merged).toHaveLength(2);
    });

    it("should handle empty replay messages", () => {
      const existing: Message[] = [
        createMessage("msg-1", 1, "Hello", "user"),
      ];

      const replayed: Message[] = [];

      const { merged } = handleReplayMerge(existing, replayed);

      expect(merged).toHaveLength(1);
    });
  });

  describe("sorting by seqId", () => {
    it("should sort merged messages by seqId ascending", () => {
      const existing: Message[] = [
        createMessage("msg-3", 3, "Third", "assistant"),
        createMessage("msg-1", 1, "First", "user"),
      ];

      const replayed: Message[] = [
        createMessage("msg-2", 2, "Second", "assistant"),
        createMessage("msg-4", 4, "Fourth", "user"),
      ];

      const { merged } = handleReplayMerge(existing, replayed);

      // Should be sorted by seqId
      expect(merged.map((m) => m.seqId)).toEqual([1, 2, 3, 4]);
    });

    it("should handle messages without seqId", () => {
      const existing: Message[] = [
        { ...createMessage("msg-1", 1, "First", "user"), seqId: undefined },
        { ...createMessage("msg-2", 2, "Second", "user"), seqId: undefined },
      ];

      const replayed: Message[] = [
        { ...createMessage("msg-3", 3, "Third", "assistant"), seqId: 5 },
      ];

      const { merged } = handleReplayMerge(existing, replayed);

      // Should handle undefined seqId gracefully - undefined treated as same key in Set
      // So 2 undefined seqId messages in existing, 1 with seqId 5 from replayed
      expect(merged).toHaveLength(3);
    });
  });

  describe("lastSeqId tracking", () => {
    it("should return max seqId from replayed messages", () => {
      const existing: Message[] = [
        createMessage("msg-1", 1, "First", "user"),
      ];

      const replayed: Message[] = [
        createMessage("msg-2", 5, "Fifth", "assistant"),
        createMessage("msg-3", 10, "Tenth", "assistant"),
        createMessage("msg-4", 3, "Third", "user"),
      ];

      const { maxSeqId } = handleReplayMerge(existing, replayed);

      expect(maxSeqId).toBe(10);
    });

    it("should return 0 when replayed messages is empty", () => {
      const existing: Message[] = [
        createMessage("msg-1", 5, "First", "user"),
      ];

      const replayed: Message[] = [];

      const { maxSeqId } = handleReplayMerge(existing, replayed);

      expect(maxSeqId).toBe(0);
    });
  });
});
