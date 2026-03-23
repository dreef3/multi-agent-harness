# Chat Message Flash Fix — Implementation Plan

> **For agentic workers:** Tasks will be executed by containerised sub-agents.
> Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.

## Overview

This plan implements the "Preserve & Merge" pattern to fix the chat message flashing issue in the frontend.

## Task Breakdown

### Task 1: Update State Management in Chat.tsx

**Repository:** multi-agent-harness
**File:** `frontend/src/pages/Chat.tsx`

**Steps:**
- [ ] Rename `loading` state variable to `isLoadingMessages` for clarity
- [ ] Ensure `messages` state is never cleared during loads
- [ ] Verify initial state is correct: `isLoadingMessages: true`, `messages: []`

**Code Change:**
```typescript
// BEFORE:
const [loading, setLoading] = useState(true);

// AFTER:
const [isLoadingMessages, setIsLoadingMessages] = useState(true);
```

---

### Task 2: Update loadMessages() Function

**Repository:** multi-agent-harness
**File:** `frontend/src/pages/Chat.tsx`

**Steps:**
- [ ] Modify `loadMessages()` to merge with existing messages instead of replacing
- [ ] Add deduplication by `seqId`
- [ ] Update `lastSeqIdRef` when new max seqId is found
- [ ] Update `isLoadingMessages` to `false` in finally block
- [ ] Handle errors gracefully by returning current state

**Code Change:**
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

---

### Task 3: Update WebSocket replay Handler

**Repository:** multi-agent-harness
**File:** `frontend/src/pages/Chat.tsx`

**Steps:**
- [ ] Update the `replay` message handler to merge instead of replace
- [ ] Add deduplication by `seqId`
- [ ] Sort merged messages by `seqId`
- [ ] Update `lastSeqIdRef` with max from replayed messages

**Code Change:**
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

---

### Task 4: Update Render Logic

**Repository:** multi-agent-harness
**File:** `frontend/src/pages/Chat.tsx`

**Steps:**
- [ ] Update initial loading check to use `isLoadingMessages`
- [ ] Update empty state check to use `isLoadingMessages`
- [ ] Ensure loading indicator only shows when truly loading AND no messages

**Code Change:**
```typescript
// Remove: if (loading) return <div className="text-gray-400">Loading...</div>;
// (Replace with conditional rendering in the messages area)

// Update the messages area conditional:
{messages.length === 0 && !streamingContent && !isThinking && !isLoadingMessages && (
  <div className="text-gray-500 text-center py-8">
    No messages yet. Start the conversation!
  </div>
)}
```

---

### Task 5: Update Conditional Loading Indicator

**Repository:** multi-agent-harness
**File:** `frontend/src/pages/Chat.tsx`

**Steps:**
- [ ] Add loading indicator that shows when loading but messages exist
- [ ] This provides feedback during refresh operations

**Code Change:**
Add this inside the messages area (before mapping messages):
```typescript
{isLoadingMessages && messages.length === 0 && (
  <div className="text-gray-400">Loading...</div>
)}
```

---

### Task 6: Verify All References to `loading` Variable

**Repository:** multi-agent-harness
**File:** `frontend/src/pages/Chat.tsx`

**Steps:**
- [ ] Find all references to the old `loading` variable
- [ ] Replace with `isLoadingMessages`
- [ ] Verify `setLoading` is replaced with `setIsLoadingMessages`

---

### Task 7: Test the Changes

**Repository:** multi-agent-harness

**Commands to run:**
```bash
cd /workspace/multi-agent-harness
npm run build  # Verify no TypeScript errors
```

**Expected Output:**
- Build completes without errors
- TypeScript compilation succeeds

---

## Summary

| Task | Description | File |
|------|-------------|------|
| 1 | Update state variable name | Chat.tsx |
| 2 | Update loadMessages() function | Chat.tsx |
| 3 | Update WebSocket replay handler | Chat.tsx |
| 4 | Update render logic for loading | Chat.tsx |
| 5 | Add conditional loading indicator | Chat.tsx |
| 6 | Update all `loading` references | Chat.tsx |
| 7 | Build and verify | Project root |

## Files Modified

- `frontend/src/pages/Chat.tsx` — All changes

## Verification Checklist

- [ ] Build succeeds without errors
- [ ] No TypeScript errors
- [ ] All `loading` references updated to `isLoadingMessages`
- [ ] Messages merge with deduplication by `seqId`
- [ ] Empty state only shows when not loading and no messages
