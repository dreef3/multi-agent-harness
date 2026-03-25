import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("telemetry module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports no-op tracer and meter when OTEL_ENABLED=false", async () => {
    process.env.OTEL_ENABLED = "false";
    const { tracer, meter } = await import("../telemetry.js");
    // No-op tracer: startSpan returns a valid (no-op) span
    const span = tracer.startSpan("test");
    expect(span).toBeDefined();
    span.end();
    // No-op meter: createCounter does not throw
    const counter = meter.createCounter("test.counter");
    expect(counter).toBeDefined();
    delete process.env.OTEL_ENABLED;
  });

  it("exports tracer and meter regardless of OTEL_ENABLED value", async () => {
    process.env.OTEL_ENABLED = "false";
    const mod = await import("../telemetry.js");
    expect(mod.tracer).toBeDefined();
    expect(mod.meter).toBeDefined();
    delete process.env.OTEL_ENABLED;
  });
});
