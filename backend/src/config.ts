// Parse "providerId/modelId" — returns null if format is invalid
function parseModelSpec(spec: string): { provider: string; model: string } | null {
  const slash = spec.indexOf('/');
  return slash > 0 ? { provider: spec.slice(0, slash), model: spec.slice(slash + 1) } : null;
}

// Default models per provider (used when AGENT_IMPLEMENTATION_MODEL is not set)
const MODEL_DEFAULTS: Record<string, { planning: string; implementation: string }> = {
  "pi":                 { planning: "claude-3-opus",     implementation: "claude-3-haiku" },
  "opencode-go":        { planning: "minimax-m2.7",      implementation: "minimax-m2.7" },
  "opencode-zen":       { planning: "opencode-zen",      implementation: "opencode-zen" },
  "google-gemini-cli":  { planning: "gemini-2.5-pro",    implementation: "gemini-2.5-flash" },
  "google-antigravity": { planning: "claude-sonnet-4-6", implementation: "gemini-3-flash" },
  "openai-codex":       { planning: "gpt-5.1",           implementation: "gpt-5.1-codex-mini" },
};

const planningSpec = parseModelSpec(
  process.env.AGENT_PLANNING_MODEL ?? "opencode-go/minimax-m2.7"
);
const agentProvider = planningSpec?.provider ?? "opencode-go";
const planningModel  = planningSpec?.model ?? MODEL_DEFAULTS[agentProvider]?.planning ?? "minimax-m2.7";

const implRaw = process.env.AGENT_IMPLEMENTATION_MODEL;
const implSpec = implRaw ? parseModelSpec(implRaw) : null;
const implementationModel = implSpec?.model
  ?? MODEL_DEFAULTS[implSpec?.provider ?? agentProvider]?.implementation
  ?? planningModel;

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
  // Maximum number of impl agents allowed to run simultaneously for a single project
  maxImplAgentsPerProject: parseInt(process.env.MAX_IMPL_AGENTS_PER_PROJECT ?? "1", 10),
  anthropicApiKeyPath:
    process.env.ANTHROPIC_API_KEY_PATH ?? "/run/secrets/api-key",
  // Named Docker volume shared between backend and sub-agents for pi agent auth (OAuth tokens)
  piAgentVolume: process.env.PI_AGENT_VOLUME ?? "harness-pi-auth",
  // Agent model configuration — set via AGENT_PLANNING_MODEL=<providerId>/<modelId>
  // e.g. AGENT_PLANNING_MODEL=google-gemini-cli/gemini-2.5-pro
  agentProvider,
  planningModel,
  implementationModel,
  harnessApiUrl: process.env.HARNESS_API_URL ?? "http://backend:3000",
  opencodeApiKey: process.env.OPENCODE_API_KEY,
  testRepoUrl: process.env.TEST_REPO_URL ?? "git@github.com:dreef3/multi-agent-harness-test-repo.git",
  // Opt-in: mount sub-agent root filesystem as read-only.
  // Requires tmpfs mounts for /tmp and /workspace.
  subAgentReadOnlyRootfs: process.env.SUB_AGENT_READONLY_ROOTFS === "true",
  // Named Docker volume for bare-repo cache shared across sub-agent containers.
  // Set HARNESS_REPO_CACHE_VOLUME="" to disable caching entirely (fallback to git clone).
  repoCacheVolume: process.env.HARNESS_REPO_CACHE_VOLUME ?? "harness-repo-cache",

  // Auth / OIDC
  authEnabled:         process.env.AUTH_ENABLED === "true",
  oidcIssuerUrl:       process.env.OIDC_ISSUER_URL ?? "",
  oidcAudience:        process.env.OIDC_AUDIENCE ?? process.env.OIDC_CLIENT_ID ?? "",
  oidcRoleClaim:       process.env.OIDC_ROLE_CLAIM ?? "roles",
  oidcRoleMapAdmin:    process.env.OIDC_ROLE_MAP_ADMIN    ?? "harness-admins",
  oidcRoleMapOperator: process.env.OIDC_ROLE_MAP_OPERATOR ?? "harness-operators",
  oidcRoleMapReviewer: process.env.OIDC_ROLE_MAP_REVIEWER ?? "harness-reviewers",
  oidcRoleMapViewer:   process.env.OIDC_ROLE_MAP_VIEWER   ?? "harness-viewers",
};
