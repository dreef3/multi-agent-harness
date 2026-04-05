import { defineConfig, devices } from '@playwright/test';

const agentConfigs = [
  { name: "pi-pi", planning: "pi", implementation: "pi" },
  { name: "copilot-copilot", planning: "copilot", implementation: "copilot" },
  { name: "pi-copilot", planning: "pi", implementation: "copilot" },
];

export default defineConfig({
  testDir: './tests',
  // Exclude Jenkins integration tests unless JENKINS_URL is set —
  // those are handled by the dedicated jenkins-integration CI job.
  testIgnore: process.env.JENKINS_URL ? undefined : ['**/jenkins-integration.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // 2 workers lets repository-flow and review-flow run concurrently.
  // Each uses a worker-unique harness repo name (E2E Test Repo 0/1) to avoid conflicts.
  workers: process.env.CI ? 2 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.HARNESS_URL || 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
  },
  projects: agentConfigs.map((cfg, i) => ({
    name: cfg.name,
    use: {
      ...devices['Desktop Chrome'],
      agentConfig: cfg,
    },
    // ci-status tests push commits and wait for GitHub Actions check runs — running them
    // in every matrix project causes resource contention.  Run only in the first project.
    testIgnore: i > 0 ? ['**/ci-status.spec.ts'] : undefined,
  })),
  timeout: 60000,
  expect: {
    timeout: 50000,
  },
});
