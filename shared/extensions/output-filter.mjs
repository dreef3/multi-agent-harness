/**
 * Pi coding-agent extension: truncates oversized read/find tool results
 * to reduce token usage. Bash results are handled by RTK via spawnHook.
 */

const THRESHOLDS = {
  read: 12_000,
  find: 4_000,
};
const DEFAULT_THRESHOLD = 4_000;

function truncateText(text, threshold) {
  if (text.length <= threshold) return null; // no truncation needed
  const removed = text.length - threshold;
  return text.slice(0, threshold) + `\n[truncated: ${removed} chars removed]`;
}

function filterToolResult(event) {
  try {
    const { toolName, content } = event;
    if (!Array.isArray(content)) return undefined;

    // RTK handles bash; extension only covers read/find/others
    if (toolName === "bash") return undefined;

    const threshold = THRESHOLDS[toolName] ?? DEFAULT_THRESHOLD;

    const textParts = content.filter(c => c.type === "text");
    if (textParts.length === 0) return undefined; // no text content

    const fullText = textParts.map(c => c.text ?? "").join("");
    const truncated = truncateText(fullText, threshold);
    if (truncated === null) return undefined; // under threshold, no change

    // Rebuild content: replace text parts with single truncated part, keep non-text
    const newContent = [
      ...content.filter(c => c.type !== "text"),
      { type: "text", text: truncated },
    ];
    return { content: newContent };
  } catch {
    return undefined; // always passthrough on error
  }
}

export function createOutputFilterExtension(_session) {
  return {
    toolResult: filterToolResult,
  };
}
