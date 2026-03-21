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
  // Agent provider configuration for E2E tests
  agentProvider: process.env.AGENT_PROVIDER ?? "opencode-go", // Only OpenCode Go is supported
  opencodeApiKey: process.env.OPENCODE_API_KEY,
  testRepoUrl: process.env.TEST_REPO_URL ?? "git@github.com:dreef3/multi-agent-harness-test-repo.git",
  
  // Provider-specific model configuration
  models: {
    // Pi agent provider (uses Claude models via Anthropic)
    pi: {
      masterAgent: {
        model: "claude-3-opus",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: "claude-3-haiku",
        temperature: 0.5,
        maxTokens: 2048,
      },
    },
    // OpenCode Go provider (uses OpenCode models)
    "opencode-go": {
      masterAgent: {
        model: "opencode-go",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: "opencode-go",
        temperature: 0.5,
        maxTokens: 2048,
      },
    },
    // OpenCode Zen provider (uses OpenCode models)
    "opencode-zen": {
      masterAgent: {
        model: "opencode-zen",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: "opencode-zen",
        temperature: 0.5,
        maxTokens: 2048,
      },
    },
  },
};
