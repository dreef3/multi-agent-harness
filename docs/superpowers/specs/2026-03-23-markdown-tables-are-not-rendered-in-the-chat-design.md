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

| File | Action |
|------|--------|
| `frontend/package.json` | Add `remark-gfm` dependency |
| `frontend/src/pages/Chat.tsx` | Import and apply `remarkGfm` plugin |

## Expected Output

After implementation, these markdown elements will render properly:

**Tables:**
```
| Feature    | Status   |
|------------|----------|
| Tables     | Supported |
| Styling    | Via prose |
```

**Task lists:**
```
- [x] Implement tables
- [ ] Add tests
```

**Strikethrough:**
```
~~deprecated text~~
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| remark-gfm | ^4.0.0 | GFM parsing for react-markdown |

## Risks & Mitigations

- **Risk:** `remark-gfm` v4 may have breaking changes from v3
  - **Mitigation:** Use `^4.0.0` range, test after install
- **Risk:** Additional bundle size
  - **Mitigation:** `remark-gfm` is a small, well-optimized package (~15KB)