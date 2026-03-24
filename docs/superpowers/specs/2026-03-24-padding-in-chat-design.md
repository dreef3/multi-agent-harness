# Remove Left/Right Padding on Mobile Chat Messages

## Summary

Remove the horizontal (left/right) padding from chat messages on mobile devices to allow full-width content display, providing more space for message content on smaller screens.

## Current Behavior

The chat message container in `frontend/src/pages/Chat.tsx` uses a fixed `p-4` Tailwind class (equivalent to `padding: 1rem` on all sides). This creates consistent padding on all sides for both mobile and desktop views.

```tsx
<div className="flex-1 overflow-y-auto space-y-3 bg-gray-900 border border-gray-800 rounded-lg p-4">
```

## Proposed Change

Modify the message container padding to be responsive:
- **Mobile (default)**: No horizontal padding (`px-0`), keep vertical padding (`py-4`)
- **Desktop (sm breakpoint and up)**: Full padding on all sides (`p-4`)

### Change Location

**File**: `frontend/src/pages/Chat.tsx`

**Current class**: `p-4`

**New class**: `py-4 px-0 sm:px-4`

This approach:
1. Keeps vertical spacing (`py-4`) to maintain visual separation from the header and input area
2. Removes horizontal padding (`px-0`) on mobile to maximize content width
3. Restores horizontal padding on larger screens (`sm:px-4`) for visual balance

### Visual Impact

| Screen Size | Current | After Change |
|-------------|---------|--------------|
| Mobile (<640px) | 16px left/right padding | 0px left/right padding |
| Desktop (≥640px) | 16px left/right padding | 16px left/right padding |

## Alternative Approaches Considered

1. **Removing all padding on mobile** - Rejected because vertical spacing is still needed for visual separation from header/footer elements.

2. **Using a custom breakpoint** - Rejected as Tailwind's default `sm:` breakpoint (640px) is appropriate for this use case.

3. **Adjusting message bubble width instead** - Considered but the container padding change is simpler and addresses the root cause directly.

## Files to Modify

1. `frontend/src/pages/Chat.tsx` - Update the message container className

## Testing Considerations

- Visual testing on mobile viewport sizes (< 640px width)
- Visual testing on desktop viewport sizes (≥ 640px width)
- Ensure message bubbles don't touch screen edges awkwardly
- Verify scrolling behavior is unaffected