import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
const TEST_REPO_OWNER = 'dreef3';
const TEST_REPO_NAME = 'multi-agent-harness-test-repo';

test.describe('GitHub Issues picker', () => {
  let repoId: string | undefined;

  test.beforeEach(async ({ request }) => {
    // Seed a test GitHub repository
    const res = await request.post(`${API_BASE}/repositories`, {
      data: {
        name: 'GH Issues E2E Repo',
        provider: 'github',
        providerConfig: { owner: TEST_REPO_OWNER, repo: TEST_REPO_NAME },
        defaultBranch: 'main',
        cloneUrl: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}.git`,
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    repoId = data.id;
  });

  test.afterEach(async ({ request }) => {
    if (repoId) {
      await request.delete(`${API_BASE}/repositories/${repoId}`);
      repoId = undefined;
    }
  });

  test('toggle shows and hides the GitHub Issues picker panel', async ({ page }) => {
    await page.goto('/projects/new');
    await expect(page.getByRole('heading', { name: /create new project/i })).toBeVisible();

    // Panel is not visible initially
    await expect(page.getByPlaceholder(/search open issues by title/i)).not.toBeVisible();

    // Click the toggle
    await page.getByRole('button', { name: /\+ add github issues/i }).click();
    await expect(page.getByPlaceholder(/search open issues by title/i)).toBeVisible();

    // Toggle again — panel hides
    await page.getByRole('button', { name: /hide github issues/i }).click();
    await expect(page.getByPlaceholder(/search open issues by title/i)).not.toBeVisible();
  });

  test('shows warning and disables search when no repository is selected', async ({ page }) => {
    await page.goto('/projects/new');
    await page.getByRole('button', { name: /\+ add github issues/i }).click();

    // Warning is visible
    await expect(page.getByText(/select repositories above/i)).toBeVisible();

    // Search button is disabled
    await expect(page.getByRole('button', { name: /^search$/i })).toBeDisabled();
  });

  test('enables search and hides warning once a repository is selected', async ({ page }) => {
    await page.goto('/projects/new');

    // Open GitHub Issues picker first
    await page.getByRole('button', { name: /\+ add github issues/i }).click();
    await expect(page.getByText(/select repositories above/i)).toBeVisible();

    // Now select the repository
    await page.locator('button:has-text("Select repositories")').click();
    await page.locator('button:has-text("GH Issues E2E Repo")').first().click();
    await page.keyboard.press('Escape');

    // Warning is gone, button is enabled
    await expect(page.getByText(/select repositories above/i)).not.toBeVisible();
    await expect(page.getByRole('button', { name: /^search$/i })).toBeEnabled();
  });

  test('searches GitHub Issues and displays results or no-results state', async ({ page }) => {
    await page.goto('/projects/new');

    // Select repository
    await page.locator('button:has-text("Select repositories")').click();
    await page.locator('button:has-text("GH Issues E2E Repo")').first().click();
    await page.keyboard.press('Escape');

    // Open GitHub Issues picker
    await page.getByRole('button', { name: /\+ add github issues/i }).click();

    // Search with a broad term
    await page.getByPlaceholder(/search open issues by title/i).fill('test');
    await page.getByRole('button', { name: /^search$/i }).click();

    // Wait for search to complete — either results or empty state (no spinner visible)
    await expect(page.getByRole('button', { name: /searching/i })).not.toBeVisible({ timeout: 15000 });

    // The search completed without error — either issues are listed or nothing is shown
    // Either way, the search button is still enabled (not in error state)
    await expect(page.getByRole('button', { name: /^search$/i })).toBeEnabled();
  });

  test('Enter key triggers search', async ({ page }) => {
    await page.goto('/projects/new');

    // Select repository and open picker
    await page.locator('button:has-text("Select repositories")').click();
    await page.locator('button:has-text("GH Issues E2E Repo")').first().click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /\+ add github issues/i }).click();

    // Type and press Enter
    await page.getByPlaceholder(/search open issues by title/i).fill('test');
    await page.getByPlaceholder(/search open issues by title/i).press('Enter');

    // Search fires — button transitions to "Searching..." and back
    // We wait for the loading state to resolve
    await expect(page.getByRole('button', { name: /searching/i })).not.toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /^search$/i })).toBeEnabled();
  });

  test('API endpoint returns valid response for configured repo', async ({ request }) => {
    // Direct API test — verify /github-issues/search responds with 200 and issues array
    const res = await request.get(
      `${API_BASE}/github-issues/search?repositoryIds=${repoId}&maxResults=5`
    );
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body).toHaveProperty('issues');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.issues)).toBeTruthy();
    expect(typeof body.total).toBe('number');
  });

  test('API endpoint returns 400 when repositoryIds is missing', async ({ request }) => {
    const res = await request.get(`${API_BASE}/github-issues/search?q=bug`);
    expect(res.status()).toBe(400);
  });

  test('API endpoint returns 400 when repositoryIds are all unknown', async ({ request }) => {
    const res = await request.get(`${API_BASE}/github-issues/search?repositoryIds=nonexistent-id`);
    expect(res.status()).toBe(400);
  });
});
