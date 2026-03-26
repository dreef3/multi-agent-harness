import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOutputFilterExtension } from "./output-filter.mjs";

function makeEvent(toolName, text, isError = false) {
  return {
    toolName,
    isError,
    content: [{ type: "text", text }],
  };
}

const ext = createOutputFilterExtension(null);

describe("output-filter extension", () => {
  it("truncates read result over 12000 chars", () => {
    const bigText = "x".repeat(15000);
    const event = makeEvent("read", bigText);
    const result = ext.toolResult(event);
    assert.ok(result !== undefined, "should return a result");
    const out = result.content[0].text;
    assert.ok(out.length <= 12001 + 100, "should be under threshold + notice");
    assert.ok(out.includes("[truncated:"), "should include truncation notice");
    assert.equal(out.slice(0, 12000), bigText.slice(0, 12000), "first 12000 chars preserved");
  });

  it("passes through read result under 12000 chars unchanged", () => {
    const text = "x".repeat(5000);
    const result = ext.toolResult(makeEvent("read", text));
    assert.equal(result, undefined, "should return undefined (passthrough)");
  });

  it("truncates find result over 4000 chars", () => {
    const big = "x".repeat(6000);
    const result = ext.toolResult(makeEvent("find", big));
    assert.ok(result !== undefined);
    assert.ok(result.content[0].text.length <= 4001 + 100);
  });

  it("does NOT truncate bash result (RTK handles bash)", () => {
    const big = "x".repeat(20000);
    const result = ext.toolResult(makeEvent("bash", big));
    assert.equal(result, undefined, "bash should pass through unchanged");
  });

  it("truncates isError read result", () => {
    const big = "x".repeat(15000);
    const result = ext.toolResult(makeEvent("read", big, true));
    assert.ok(result !== undefined);
    assert.ok(result.content[0].text.includes("[truncated:"));
  });

  it("passes through non-text content unchanged", () => {
    const event = { toolName: "read", isError: false, content: [{ type: "image", data: "abc" }] };
    const result = ext.toolResult(event);
    assert.equal(result, undefined, "non-text content should pass through");
  });

  it("returns undefined (passthrough) on exception", () => {
    const badEvent = { toolName: "read", isError: false, content: null };
    const result = ext.toolResult(badEvent);
    assert.equal(result, undefined, "should not throw on malformed event");
  });
});
