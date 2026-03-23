# Implementation Plan: Fix Markdown Table Rendering in Chat

> **For agentic workers:** Tasks will be executed by containerised sub-agents. Each sub-agent receives its task via the TASK_DESCRIPTION environment variable.

## Overview

Add `remark-gfm` package to enable full GitHub Flavored Markdown (GFM) support in the Chat component, allowing tables, task lists, and strikethrough to render properly.

## Files Modified

| File | Change |
|------|--------|
| `frontend/package.json` | Add `remark-gfm` dependency |
| `frontend/src/pages/Chat.tsx` | Import and apply `remarkGfm` plugin |

---

## Task 1: Add remark-gfm dependency

**Repository:** multi-agent-harness  
**Description:**
Add `remark-gfm` v4 to the frontend package.json dependencies.

**Changes:**
- Add `"remark-gfm": "^4.0.0"` to dependencies section

---

## Task 2: Update Chat.tsx with remark-gfm plugin

**Repository:** multi-agent-harness  
**Description:**
Modify `frontend/src/pages/Chat.tsx` to import and apply the remarkGfm plugin.

**Changes:**
1. Add import: `import remarkGfm from 'remark-gfm';`
2. Add `remarkPlugins={[remarkGfm]}` to both ReactMarkdown instances

---

## Verification

```bash
cd frontend && npm install && npx tsc --noEmit
```

## Summary

| Task | File | Changes |
|------|------|---------|
| 1 | `frontend/package.json` | Add `remark-gfm: ^4.0.0` |
| 2 | `frontend/src/pages/Chat.tsx` | Import and apply `remarkGfm` plugin |