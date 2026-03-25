import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { trace, metrics } from "@opentelemetry/api";

const enabled = process.env.OTEL_ENABLED !== "false";
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://host.docker.internal:4318";
const serviceName = process.env.OTEL_SERVICE_NAME ?? "multi-agent-harness";

if (enabled) {
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
  });

  try {
    sdk.start();
    console.log(`[telemetry] OTEL SDK started (endpoint=${endpoint} service=${serviceName})`);
  } catch (err) {
    console.warn("[telemetry] OTEL SDK failed to start (non-fatal):", err);
  }

  const shutdown = () => sdk.shutdown().catch(e => console.warn("[telemetry] shutdown error:", e));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export const tracer = trace.getTracer("harness");
export const meter = metrics.getMeter("harness");
