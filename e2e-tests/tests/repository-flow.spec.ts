import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const TEST_REPO_OWNER = 'dreef3';
const TEST_REPO_NAME = 'multi-agent-harness-test-repo';
const TEST_REPO_HTTPS_URL = `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}.git`;

test.describe('Repository Configuration Flow', () => {
  let initialBranchNames: string[] = [];

  test.beforeEach(async ({ request }) => {
    // Record current branches so we can detect new ones after the test
    const branchRes = await request.get(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
      { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
    );
    if (branchRes.ok) {
      const branches = await branchRes.json();
      initialBranchNames = (branches as { name: string }[]).map(b => b.name);
    }

    // Seed test repository via API
    await request.post(`${API_BASE}/repositories`, {
      data: {
        name: 'E2E Test Repo',
        provider: 'github',
        providerConfig: { owner: TEST_REPO_OWNER, repo: TEST_REPO_NAME },
        defaultBranch: 'main',
        cloneUrl: TEST_REPO_HTTPS_URL,
      },
    });
  });

  test.afterEach(async ({ request }) => {
    const repos = await request.get(`${API_BASE}/repositories`);
    if (repos.ok) {
      const data = await repos.json();
      for (const repo of (data as { id: string; name: string }[])) {
        if (repo.name === 'E2E Test Repo') {
          await request.delete(`${API_BASE}/repositories/${repo.id}`);
        }
      }
    }
  });

  test('create project with repository and verify sub-agent pushes a branch', async ({ page, request }) => {
    test.setTimeout(10 * 60 * 1000); // 10 minutes — covers full agent execution cycle

    // Navigate to new project form
    await page.goto('/');
    await page.getByRole('main').getByRole('link', { name: /\+ new project/i }).click();
    await expect(page.getByRole('heading', { name: /create new project/i })).toBeVisible();

    // Fill project details
    await page.getByPlaceholder(/my awesome project/i).fill(`E2E Task ${Date.now()}`);
    await page.getByPlaceholder(/what do you want to build/i).fill(
      'Create a simple marker file in the repository'
    );

    // Select the test repository
    await page.locator('button:has-text("Select repositories")').click();
    await page.locator('button:has-text("E2E Test Repo")').first().click();
    await page.keyboard.press('Escape');
    await expect(page.locator('span:has-text("E2E Test Repo")').first()).toBeVisible();

    // Create project and wait for redirect to chat
    await page.getByRole('button', { name: /create project/i }).click();
    await expect(page).toHaveURL(/\/projects\/[\w-]+\/chat/, { timeout: 10000 });
    await expect(page.getByPlaceholder(/type your message/i)).toBeVisible({ timeout: 10000 });

    // Send a task that explicitly invokes superpowers skills.
    // Keeping the request concise to minimize token usage.
    const taskMessage = [
      'Please execute these superpowers skills in order, keeping each step brief:',
      '1. /brainstorm — one paragraph analysis only',
      '2. /writing-plans — write the implementation plan',
      '',
      'Task: In the "E2E Test Repo" repository, create a file called `e2e-marker.md`',
      'with the single line "# E2E Test Passed". Commit it to a new branch.',
      '',
      'The plan must follow the exact format with ### Task, **Repository:**, and **Description:** sections.',
    ].join('\n');

    await page.getByPlaceholder(/type your message/i).fill(taskMessage);
    await page.getByRole('button', { name: /send/i }).click();

    // Wait for agent response to appear
    await expect(page.locator('.bg-gray-800').first()).toBeVisible({ timeout: 120000 });

    // Wait for auto-navigation to plan approval page
    await expect(page).toHaveURL(/\/projects\/[\w-]+\/plan/, { timeout: 300000 });

    // Approve the plan
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /approve/i }).click();

    // Extract project ID from URL
    const projectId = page.url().match(/\/projects\/([\w-]+)/)?.[1];
    expect(projectId).toBeDefined();

    // Poll for sub-agent session completing — proves the container was spun up and ran
    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}/agents`);
        if (!res.ok) return false;
        const sessions = await res.json() as { type: string; status: string }[];
        return sessions.some(s => s.type === 'sub' && s.status === 'completed');
      },
      { timeout: 300000, intervals: [10000] }
    ).toBe(true);

    // Verify a new branch was pushed to the test repo — proves the commit+push happened
    await expect.poll(
      async () => {
        const res = await request.get(
          `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
          { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
        );
        if (!res.ok) return false;
        const branches = await res.json() as { name: string }[];
        return branches.some(b => !initialBranchNames.includes(b.name));
      },
      { timeout: 60000, intervals: [5000] }
    ).toBe(true);
  });
});
