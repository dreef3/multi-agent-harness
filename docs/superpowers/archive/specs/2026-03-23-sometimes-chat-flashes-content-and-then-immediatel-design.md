# Chat Message Flash Fix — Design Spec

## Problem Statement

The chat interface experiences a visual bug where:
1. Messages briefly appear and then immediately disappear
2. After a reconnection, the chat shows "No messages yet" even when a long message history exists
3. During project navigation, there's a jarring flash of empty state before messages load

This occurs due to improper state management during message loading and WebSocket reconnection.

---

## Goals

1. **No Message Flashing** — Messages should never disappear once loaded, even during reconnection or navigation
2. **Graceful Degradation** — Loading states should show appropriately without clearing existing content
3. **Message Integrity** — All messages from server and WebSocket should be preserved and deduplicated

---

## Design Approach: Preserve & Merge

### Core Principles

1. **Never clear messages during loads** — Only add/update, never replace without good reason
2. **Merge from multiple sources** — Combine server REST API and WebSocket data
3. **Deduplicate by seqId** — Use sequence IDs to prevent duplicate messages
4. **Track loading state separately** — Show loading indicator without clearing content

---

## Changes

### 1. State Management (`Chat.tsx`)

**Before:**
```tsx
const [messages, setMessages] = useState<Message[]>([]);
const [loading, setLoading] = useState(true);
```

**After:**
```tsx
const [messages, setMessages] = useState<Message[]>([]);
const [isLoadingMessages, setIsLoadingMessages] = useState(true);
```

Key changes:
- Rename `loading` to `isLoadingMessages` for clarity
- Messages are never cleared during loads
- Add deduplication when merging new messages

### 2. Enhanced `loadMessages()` Function

```typescript
async function loadMessages(): Promise<Message[]> {
  if (!id) return [];
  try {
    const data = await api.projects.messages.list(id);
    
    // Merge with existing messages, deduplicate by seqId
    setMessages(prev => {
      const existingSeqIds = new Set(prev.map(m => m.seqId));
      const newMsgs = data.filter(m => !existingSeqIds.has(m.seqId));
      
      if (newMsgs.length === 0) return prev;  // No new messages
      
      const merged = [...prev, ...newMsgs]
        .sort((a, b) => (a.seqId ?? 0) - (b.seqId ?? 0));
      return merged;
    });
    
    // Update last known good state
    const maxSeq = data.reduce((m, msg) => Math.max(m, msg.seqId ?? 0), 0);
    if (maxSeq > lastSeqIdRef.current) lastSeqIdRef.current = maxSeq;
    
    return data;
  } catch (err) {
    console.error("Failed to load messages:", err);
    return messages;  // Return current state on error
  } finally {
    setIsLoadingMessages(false);
  }
}
```

### 3. Improved WebSocket `replay` Handler

```typescript
} else if (msg.type === "replay" && Array.isArray(msg.messages)) {
  const replayedMessages = msg.messages as Message[];
  
  // Merge replay messages with existing, deduplicate by seqId
  setMessages(prev => {
    const existingSeqIds = new Set(prev.map(m => m.seqId));
    const newFromReplay = replayedMessages.filter(m => !existingSeqIds.has(m.seqId));
    
    if (newFromReplay.length === 0) return prev;
    
    const merged = [...prev, ...newFromReplay]
      .sort((a, b) => (a.seqId ?? 0) - (b.seqId ?? 0));
    return merged;
  });
  
  const maxSeq = replayedMessages.reduce((m, msg) => Math.max(m, msg.seqId ?? 0), 0);
  if (maxSeq > lastSeqIdRef.current) lastSeqIdRef.current = maxSeq;
}
```

### 4. Updated Render Logic

```tsx
// Show loading state only when no messages exist AND still loading
{isLoadingMessages && messages.length === 0 && (
  <div className="text-gray-400">Loading...</div>
)}

// Show empty state only when NOT loading AND no messages
{!isLoadingMessages && messages.length === 0 && !streamingContent && !isThinking && (
  <div className="text-gray-500 text-center py-8">
    No messages yet. Start the conversation!
  </div>
)}
```

### 5. Project Navigation Cleanup

The existing `useEffect` already handles project change by `[id]` dependency. On project change:
- Component re-renders, state resets to initial values
- `loadMessages()` is called immediately
- Loading indicator shows until first messages arrive
- No flash if messages arrive quickly

---

## File Changes

| File | Change |
|------|--------|
| `frontend/src/pages/Chat.tsx` | Update state management and merge logic |

---

## Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Fast reconnection | Existing messages stay visible, new ones merge in |
| Slow network | Loading indicator shows, content preserved |
| Empty history | "No messages yet" shows after load completes |
| WebSocket replay | Messages merge with existing, deduplicated by seqId |
| API error | Current messages preserved, error logged |
| Project switch | Fresh load for new project |

---

## Testing Considerations

1. **Flashing Test**: Navigate away and back quickly, messages should persist
2. **Reconnection Test**: Disconnect WebSocket, reconnect, messages should not flash
3. **Empty State Test**: Create new project, verify "No messages yet" shows correctly
4. **Deduplication Test**: Send many messages, verify no duplicates appear

---

## Risk Assessment

- **Risk Level**: Low
- **Scope**: Frontend-only change
- **Dependencies**: None
- **Rollback**: Single file change, easy to revert

---

## Success Criteria

1. ✅ No visible flashing of messages during any navigation or reconnection
2. ✅ Messages persist across WebSocket reconnections
3. ✅ Empty state correctly shows when genuinely no messages exist
4. ✅ No duplicate messages appear from multiple sources
