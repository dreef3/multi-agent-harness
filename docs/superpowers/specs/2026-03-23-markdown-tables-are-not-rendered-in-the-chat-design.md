# Fix Markdown Table Rendering in Chat

## Problem

When the planning agent responds with markdown tables (GFM - GitHub Flavored Markdown), they render as plain text in the Chat component. This makes task lists and tables difficult to read.

**Example of broken output:**
```
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
```

## Solution

Add `remark-gfm` plugin to `react-markdown` to enable full GFM support:
- Tables
- Strikethrough (`~~text~~`)
- Task lists (`- [ ]`, `- [x]`)
- Autolinks

The existing `prose prose-invert` Tailwind Typography classes will style the output appropriately for the dark theme.

## Files to Modify

### 1. `frontend/package.json`
Add `remark-gfm` as a dependency.

### 2. `frontend/src/pages/Chat.tsx`
- Import `remark-gfm`
- Pass `remarkPlugins={[remarkGfm]}` to both `ReactMarkdown` instances

## Implementation Details

### package.json changes
```json
{
  "remark-gfm": "^4.0.0"
}
```

### Chat.tsx changes

**Import:**
```tsx
import remarkGfm from 'remark-gfm';
```

**ReactMarkdown instances (2 locations):**

1. Message rendering (around line 118):
```tsx
<div className="prose prose-invert prose-sm max-w-none">
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
</div>
```

2. Streaming content (around line 135):
```tsx
<div className="prose prose-invert prose-sm max-w-none">
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
</div>
```

## Expected Output

After implementation, these markdown elements will render properly:

**Tables:**
```
| Feature    | Status   |
|------------|----------|
| Tables     | Supported |
| Styling    | Via prose |
```
Renders as a styled table with dark theme.

**Task lists:**
```
- [x] Implement tables
- [ ] Add tests
```
Renders as checkbox-style task list.

**Strikethrough:**
```
~~deprecated text~~
```
Renders with strikethrough styling.

## Testing

1. Send a message prompting the planning agent to respond with a markdown table
2. Verify the table renders correctly with proper styling
3. Test task lists and strikethrough if included in responses

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| remark-gfm | ^4.0.0 | GFM parsing for react-markdown |

## Risks & Mitigations

- **Risk:** `remark-gfm` v4 may have breaking changes from v3
  - **Mitigation:** Use `^4.0.0` range, test after install
- **Risk:** Additional bundle size
  - **Mitigation:** `remark-gfm` is a small, well-optimized package (~15KB)
