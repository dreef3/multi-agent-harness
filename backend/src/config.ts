export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  dataDir: process.env.DATA_DIR ?? "./data",
  dockerProxyUrl: process.env.DOCKER_PROXY_URL ?? "http://docker-proxy:2375",
  subAgentImage:
    process.env.SUB_AGENT_IMAGE ?? "multi-agent-harness/sub-agent:latest",
  planningAgentImage:
    process.env.PLANNING_AGENT_IMAGE ?? "multi-agent-harness/planning-agent:latest",
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
  // Must exceed subAgentTimeoutMs (default 30 min). Use literal — config object cannot reference its own properties during construction.
  staleSessionThresholdMs: parseInt(
    process.env.STALE_SESSION_THRESHOLD_MS ?? String(35 * 60 * 1000),
    10
  ),
  subAgentMaxRetries: parseInt(process.env.SUB_AGENT_MAX_RETRIES ?? "1", 10),
  // Maximum number of sub-agent containers allowed to run simultaneously (across all projects)
  maxConcurrentSubAgents: parseInt(process.env.MAX_CONCURRENT_SUB_AGENTS ?? "3", 10),
  anthropicApiKeyPath:
    process.env.ANTHROPIC_API_KEY_PATH ?? "/run/secrets/api-key",
  // Named Docker volume shared between backend and sub-agents for pi agent auth (OAuth tokens)
  piAgentVolume: process.env.PI_AGENT_VOLUME ?? "harness-pi-auth",
  // Agent provider configuration
  agentProvider: process.env.AGENT_PROVIDER ?? "opencode-go",
  harnessApiUrl: process.env.HARNESS_API_URL ?? "http://backend:3000",
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
        model: process.env.OPENCODE_PLANNING_MODEL ?? "minimax-m2.7",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: process.env.OPENCODE_IMPLEMENTATION_MODEL ?? "minimax-m2.7",
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
    // Google Gemini CLI provider (uses local OAuth via pi-agent volume)
    "google-gemini-cli": {
      masterAgent: {
        model: process.env.GEMINI_PLANNING_MODEL ?? "gemini-2.5-pro",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: process.env.GEMINI_IMPLEMENTATION_MODEL ?? "gemini-2.5-flash",
        temperature: 0.5,
        maxTokens: 2048,
      },
    },
    // Google Antigravity provider (uses local OAuth via pi-agent volume)
    "google-antigravity": {
      masterAgent: {
        model: process.env.ANTIGRAVITY_PLANNING_MODEL ?? "claude-sonnet-4-6",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: process.env.ANTIGRAVITY_IMPLEMENTATION_MODEL ?? "gemini-3-flash",
        temperature: 0.5,
        maxTokens: 2048,
      },
    },
    // OpenAI Codex provider
    "openai-codex": {
      masterAgent: {
        model: process.env.CODEX_PLANNING_MODEL ?? "gpt-5.1",
        temperature: 0.7,
        maxTokens: 4096,
      },
      workerAgent: {
        model: process.env.CODEX_IMPLEMENTATION_MODEL ?? "gpt-5.1-codex-mini",
        temperature: 0.5,
        maxTokens: 2048,
      },
    },
  },
};
