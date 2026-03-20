export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  dataDir: process.env.DATA_DIR ?? "./data",
  dockerProxyUrl: process.env.DOCKER_PROXY_URL ?? "http://docker-proxy:2375",
  subAgentImage:
    process.env.SUB_AGENT_IMAGE ?? "multi-agent-harness/sub-agent:latest",
  subAgentNetwork:
    process.env.SUB_AGENT_NETWORK ?? "multi-agent-harness_harness-agents",
  // 4 GB
  subAgentMemoryBytes: parseInt(
    process.env.SUB_AGENT_MEMORY_BYTES ?? String(4 * 1024 * 1024 * 1024),
    10
  ),
  subAgentCpuCount: parseInt(process.env.SUB_AGENT_CPU_COUNT ?? "2", 10),
  // 30 minutes
  subAgentTimeoutMs: parseInt(
    process.env.SUB_AGENT_TIMEOUT_MS ?? String(30 * 60 * 1000),
    10
  ),
  // 1 hour idle before teardown
  subAgentIdleTimeoutMs: parseInt(
    process.env.SUB_AGENT_IDLE_TIMEOUT_MS ?? String(60 * 60 * 1000),
    10
  ),
  subAgentMaxRetries: parseInt(process.env.SUB_AGENT_MAX_RETRIES ?? "3", 10),
  anthropicApiKeyPath:
    process.env.ANTHROPIC_API_KEY_PATH ?? "/run/secrets/api-key",
};
