import { test, expect } from '@playwright/test';

test.describe('Multi-Agent Harness E2E', () => {
  test('create project and run free form request', async ({ page, request }) => {
    test.setTimeout(5 * 60 * 1000); // 5 minutes — covers Docker startup + git clone + model API call
    // Seed a test repository first (required for project creation)
    const repoResponse = await request.post('http://localhost:3000/api/repositories', {
      data: {
        name: 'E2E Test Repo',
        provider: 'github',
        providerConfig: {
          owner: 'dreef3',
          repo: 'multi-agent-harness-test-repo',
        },
        defaultBranch: 'main',
        cloneUrl: 'https://github.com/dreef3/multi-agent-harness-test-repo.git',
      },
    });
    expect(repoResponse.ok()).toBeTruthy();

    // Navigate to the home page
    await page.goto('/');
    
    // Wait for the dashboard to load
    await expect(page.getByText('Multi-Agent Harness')).toBeVisible();
    
    // Click on "New Project" link
    await page.getByRole('main').getByRole('link', { name: /\+ new project/i }).click();
    
    // Wait for the new project form
    await expect(page.getByRole('heading', { name: /create new project/i })).toBeVisible();
    
    // Fill in project details
    const projectName = `E2E Test Project ${Date.now()}`;
    await page.getByPlaceholder(/my awesome project/i).fill(projectName);

    // Fill in description with a free form request
    await page.getByPlaceholder(/what do you want to build/i).fill('Please analyze the codebase structure and tell me what you find');

    // Select repository (required)
    await page.locator('button:has-text("Select repositories")').click();
    await page.locator('button:has-text("E2E Test Repo")').first().click();
    // Close dropdown by clicking outside or pressing Escape
    await page.keyboard.press('Escape');
    
    // Submit the form
    await page.getByRole('button', { name: /create project/i }).click();
    
    // Wait to be redirected to the chat page
    await expect(page).toHaveURL(/\/projects\/[\w-]+\/chat/);
    
    // Wait for chat interface to load
    await expect(page.getByPlaceholder(/type your message/i)).toBeVisible({ timeout: 10000 });

    // The freeform description was auto-sent on page load.
    // Wait for streaming content to appear (arrives on first delta, much faster than full response).
    // Accepts either the live streaming bubble or a persisted message bubble.
    const agentContent = page.locator('[data-testid="assistant-streaming"], [data-testid="assistant-message"]');
    await expect(agentContent.first()).toBeVisible({ timeout: 4 * 60 * 1000 });

    // Verify the response contains some content
    const responseText = await agentContent.first().textContent();
    expect(responseText?.trim()).toBeTruthy();
    
    // Take a screenshot for verification
    await page.screenshot({ path: 'test-results/e2e-success.png', fullPage: true });

    // Cleanup: Delete test repository
    const repos = await request.get('http://localhost:3000/api/repositories');
    if (repos.ok) {
      const data = await repos.json();
      for (const repo of data) {
        if (repo.name === 'E2E Test Repo') {
          await request.delete(`http://localhost:3000/api/repositories/${repo.id}`);
        }
      }
    }
  });
  
  test('health check', async ({ request }) => {
    // Test the backend health endpoint
    const response = await request.get('http://localhost:3000/api/health');
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });
});
