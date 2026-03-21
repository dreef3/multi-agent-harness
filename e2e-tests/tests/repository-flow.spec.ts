import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';

test.describe('Repository Configuration Flow', () => {
  test.beforeEach(async ({ page, request }) => {
    // Seed a test repository
    await request.post(`${API_BASE}/repositories`, {
      data: {
        name: 'E2E Test Repo',
        provider: 'github',
        providerConfig: {
          owner: process.env.TEST_REPO_OWNER || 'dreef3',
          repo: process.env.TEST_REPO_NAME || 'multi-agent-harness-test-repo',
        },
        defaultBranch: 'main',
        cloneUrl: `https://github.com/${process.env.TEST_REPO_OWNER || 'dreef3'}/${process.env.TEST_REPO_NAME || 'multi-agent-harness-test-repo'}.git`,
      },
    });

    // Navigate to home
    await page.goto('/');
    await expect(page.getByText('Multi-Agent Harness')).toBeVisible();
  });

  test('create project with repository and verify PR creation', async ({ page, request }) => {
    const projectName = `E2E Repo Test ${Date.now()}`;

    // 1. Navigate to new project
    await page.getByRole('link', { name: /\+ new project/i }).click();
    await expect(page.getByRole('heading', { name: /create new project/i })).toBeVisible();

    // 2. Fill in project details
    await page.getByPlaceholder(/my awesome project/i).fill(projectName);
    await page.getByPlaceholder(/what do you want to build/i).fill(
      'Add a README.md file with a brief project description. The README should include the project name and a one-sentence description.'
    );

    // 3. Select repository
    const repoDropdown = page.getByRole('button', { name: /select repositories/i });
    await repoDropdown.click();
    // Use .first() in case there are multiple repos with same name
    await page.getByRole('button', { name: /E2E Test Repo/ }).first().click();
    await repoDropdown.click(); // Close dropdown

    // Verify repository is selected
    await expect(page.getByText('E2E Test Repo')).toBeVisible();

    // 4. Create project
    await page.getByRole('button', { name: /create project/i }).click();

    // 5. Wait for redirect to chat page
    await expect(page).toHaveURL(/\/projects\/[\w-]+\/chat/, { timeout: 10000 });

    // 6. Wait for chat interface
    await expect(page.getByPlaceholder(/type your message/i)).toBeVisible({ timeout: 10000 });

    // 7. Send a message to trigger brainstorming
    const testMessage = 'Please create a README.md file with the project description';
    await page.getByPlaceholder(/type your message/i).fill(testMessage);
    await page.getByRole('button', { name: /send/i }).click();

    // 8. Wait for agent response (long timeout for AI)
    const assistantMessages = page.locator('.bg-gray-800');
    await expect(assistantMessages.first()).toBeVisible({ timeout: 180000 });

    // 9. Navigate to plan page
    const currentUrl = page.url();
    const projectId = currentUrl.match(/\/projects\/([\w-]+)\/chat/)?.[1];
    expect(projectId).toBeDefined();
    await page.goto(`/projects/${projectId}/plan`);

    // 10. Wait for plan to be ready
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible({ timeout: 180000 });

    // 11. Approve the plan
    await page.getByRole('button', { name: /approve/i }).click();

    // 12. Wait for execution status
    await expect(page.getByText(/executing/i)).toBeVisible({ timeout: 60000 });

    // 13. Poll for PR creation (up to 10 minutes)
    let prCreated = false;
    const maxAttempts = 120; // 120 * 5 seconds = 10 minutes
    
    for (let i = 0; i < maxAttempts; i++) {
      const response = await request.get(`${API_BASE}/projects/${projectId}/prs`);
      if (response.ok) {
        const prs = await response.json();
        if (prs && prs.length > 0) {
          const pr = prs[0];
          expect(pr.status).toBe('open');
          expect(pr.url).toContain('github.com');
          prCreated = true;
          break;
        }
      }
      // Wait 5 seconds before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    expect(prCreated).toBe(true);

    // Take screenshot for verification
    await page.screenshot({ path: 'test-results/repo-flow-success.png', fullPage: true });
  });

  test.afterEach(async ({ request }) => {
    // Cleanup: Delete test repository
    const repos = await request.get(`${API_BASE}/repositories`);
    if (repos.ok) {
      const data = await repos.json();
      for (const repo of data) {
        if (repo.name === 'E2E Test Repo') {
          await request.delete(`${API_BASE}/repositories/${repo.id}`);
        }
      }
    }
  });
});