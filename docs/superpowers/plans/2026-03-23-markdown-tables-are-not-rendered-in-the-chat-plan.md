# Implementation Plan: Fix Markdown Table Rendering in Chat

> **For agentic workers:** Tasks will be executed by containerised sub-agents. Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.

## Overview

Add `remark-gfm` package to enable full GitHub Flavored Markdown (GFM) support in the Chat component, allowing tables, task lists, and strikethrough to render properly.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/package.json` | Add `remark-gfm` dependency |
| `frontend/src/pages/Chat.tsx` | Import and apply `remarkGfm` plugin |

---

## Task 1: Add remark-gfm dependency

**Repository:** multi-agent-harness  
**Description:**
Add `remark-gfm` v4 to the frontend package.json dependencies.

**Steps:**
1. Read `frontend/package.json`
2. Add `"remark-gfm": "^4.0.0"` to the `dependencies` section
3. Verify the JSON is valid

**Expected file content (partial):**
```json
{
  "name": "@multi-agent-harness/frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "bunx vite",
    "build": "tsc && bunx vite build",
    "preview": "bunx vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-markdown": "^9.0.1",
    "react-router-dom": "^6.21.0",
    "remark-gfm": "^4.0.0"
  },
  ...
}
```

---

## Task 2: Update Chat.tsx with remark-gfm import and plugin

**Repository:** multi-agent-harness  
**Description:**
Modify `frontend/src/pages/Chat.tsx` to:
1. Import `remarkGfm` from `remark-gfm`
2. Add `remarkPlugins={[remarkGfm]}` to the first `ReactMarkdown` component (message rendering)
3. Add `remarkPlugins={[remarkGfm]}` to the second `ReactMarkdown` component (streaming content)

**Steps:**
1. Read `frontend/src/pages/Chat.tsx`
2. Add import on line 3 (after `import ReactMarkdown`):
   ```tsx
   import remarkGfm from 'remark-gfm';
   ```
3. Find the first `ReactMarkdown` usage (around line 118) for message content:
   ```tsx
   <ReactMarkdown>{msg.content}</ReactMarkdown>
   ```
   Replace with:
   ```tsx
   <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
   ```
4. Find the second `ReactMarkdown` usage (around line 135) for streaming content:
   ```tsx
   <ReactMarkdown>{streamingContent}</ReactMarkdown>
   ```
   Replace with:
   ```tsx
   <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
   ```

**Expected import section:**
```tsx
import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, Message, Project } from "../lib/api";
import { wsClient } from "../lib/ws";
```

**Expected ReactMarkdown changes:**
- Line ~120: `<ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>`
- Line ~137: `<ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>`

---

## Task 3: Install dependencies and verify build

**Repository:** multi-agent-harness  
**Description:**
Install the new dependency and verify the frontend builds successfully.

**Steps:**
1. Navigate to `frontend/` directory
2. Run `bun install` to install new dependencies
3. Run `bun run build` or `bun run dev` to verify no build errors
4. Verify TypeScript compilation passes

**Expected output:**
```
$ bun install
+ remark-gfm@4.x.x

$ bun run build
✓ built in X.XXs
```

---

## Task 4: Run existing tests

**Repository:** multi-agent-harness  
**Description:**
Run any existing frontend tests to ensure no regressions.

**Steps:**
1. Check for test scripts in `frontend/package.json`
2. Run `bun test` or equivalent if tests exist
3. Verify all tests pass

**Note:** If no tests exist in the frontend, skip this task.

---

## Summary

| Task | File | Changes |
|------|------|---------|
| 1 | `frontend/package.json` | Add `remark-gfm: ^4.0.0` |
| 2 | `frontend/src/pages/Chat.tsx` | Import and apply `remarkGfm` plugin |
| 3 | `frontend/` | Install dependencies |
| 4 | (optional) | Run tests |

## Verification

After implementation, test by prompting the planning agent with a request that would generate markdown tables, task lists, or strikethrough. Verify they render correctly in the Chat interface.
