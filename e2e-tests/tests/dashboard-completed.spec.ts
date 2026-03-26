import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';

test('Dashboard hides completed projects by default and shows them when toggled', async ({ page, request }) => {
  // Arrange: create a repository and two projects (one completed, one active)
  const repoRes = await request.post(`${API_BASE}/repositories`, {
    data: {
      name: `E2E Repo for Dashboard Completed ${Date.now()}`,
      provider: 'github',
      providerConfig: { owner: 'dreef3', repo: 'multi-agent-harness-test-repo' },
      cloneUrl: 'https://github.com/dreef3/multi-agent-harness-test-repo',
    },
  });
  expect(repoRes.ok()).toBe(true);
  const repo = await repoRes.json();
  const repoId = repo.id;

  // Create completed project
  const completedRes = await request.post(`${API_BASE}/projects`, {
    data: {
      name: 'Completed Project',
      description: 'A project that is completed',
      repositoryIds: [repoId],
    },
  });
  expect(completedRes.ok()).toBe(true);
  const completedProject = await completedRes.json();
  // Patch to set status to completed
  const patchRes = await request.patch(`${API_BASE}/projects/${completedProject.id}`, {
    data: { status: 'completed' },
  });
  expect(patchRes.ok()).toBe(true);

  // Create active project
  const activeRes = await request.post(`${API_BASE}/projects`, {
    data: {
      name: 'Active Project',
      description: 'A project that is active',
      repositoryIds: [repoId],
    },
  });
  expect(activeRes.ok()).toBe(true);

  // Act: Visit Dashboard
  await page.goto('/');

  // Wait for projects to appear (active project should be visible)
  const active = page.locator('text=Active Project');
  await expect(active).toBeVisible();

  const completed = page.locator('text=Completed Project');
  // Assert: completed project name is NOT visible by default
  await expect(completed).not.toBeVisible();

  // Click the "Show completed projects" toggle
  const toggle = page.getByLabel('Show completed projects');
  await toggle.check();

  // Assert: completed project name and "Completed" badge become visible
  await expect(page.locator('text=Completed Project')).toBeVisible();
  await expect(page.locator('text=Completed')).toBeVisible();

  // Additionally ensure Execute action is not present for the completed project
  const completedArticle = page.locator('article[aria-label*="Completed Project"]');
  const executeInCompleted = completedArticle.locator('text=Execute');
  expect(await executeInCompleted.count()).toBe(0);
});
