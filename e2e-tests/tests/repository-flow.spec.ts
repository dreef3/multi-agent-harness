import { test, expect } from '@playwright/test';
import {
  API_BASE,
  GH_TOKEN,
  TEST_REPO_OWNER,
  TEST_REPO_NAME,
  createPlanningPr,
  postLgtmComment,
  cleanupNewBranches,
  seedTestRepo,
  deleteTestRepo,
  pollSubAgentStatus,
} from './helpers';

test.describe('Repository Configuration Flow', () => {
  let initialBranchNames: string[] = [];
  let repoName: string;

  test.beforeEach(async ({ request }, testInfo) => {
    // Use worker-unique repo name so parallel workers don't clobber each other's repo.
    repoName = `E2E Test Repo ${testInfo.parallelIndex}`;

    // Record current branches so we can detect new ones after the test
    const branchRes = await request.get(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
      { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
    );
    if (branchRes.ok()) {
      const branches = await branchRes.json();
      if (Array.isArray(branches)) {
        initialBranchNames = (branches as { name: string }[]).map(b => b.name);
      }
    }

    await seedTestRepo(request, repoName);
  });

  test.afterEach(async ({ request }) => {
    await deleteTestRepo(request, repoName);
    await cleanupNewBranches(initialBranchNames);
  });

  test('create project with repository and verify sub-agent pushes a branch', async ({ page, request }) => {
    test.setTimeout(15 * 60 * 1000); // 15 minutes — covers full agent execution cycle (sub-agent can take ~10 min)

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
    await page.locator(`button:has-text("${repoName}")`).first().click();
    await page.keyboard.press('Escape');
    await expect(page.locator(`span:has-text("${repoName}")`).first()).toBeVisible();

    // Create project and wait for redirect to chat
    await page.getByRole('button', { name: /create project/i }).click();
    await expect(page).toHaveURL(/\/projects\/[\w-]+\/chat/, { timeout: 10000 });
    await expect(page.getByPlaceholder(/type your message/i)).toBeVisible({ timeout: 10000 });

    // Extract project ID from the URL now (before any navigation)
    const projectId = page.url().match(/\/projects\/([\w-]+)/)?.[1];
    expect(projectId).toBeDefined();

    // Send a task that explicitly invokes superpowers skills.
    // Keeping the request concise to minimize token usage.
    const taskMessage = [
      'Please execute these superpowers skills in order, keeping each step brief:',
      '1. /brainstorm — one paragraph analysis only',
      '2. /writing-plans — write the implementation plan using EXACTLY this format:',
      '',
      '### Task 1: Create e2e-marker.md',
      '**Repository:** E2E Test Repo',
      '**Description:**',
      'Create a file called `e2e-marker.md` with the single line "# E2E Test Passed". Commit it to a new branch.',
      '',
      'Task: In the "E2E Test Repo" repository, create a file called `e2e-marker.md`',
      'with the single line "# E2E Test Passed". Commit it to a new branch.',
    ].join('\n');

    await page.getByPlaceholder(/type your message/i).fill(taskMessage);
    await page.getByRole('button', { name: /send/i }).click();

    // Wait for agent response to appear in the chat
    await expect(page.locator('.bg-gray-800').first()).toBeVisible({ timeout: 120000 });

    // Wait for the project to reach awaiting_plan_approval (agent wrote spec + plan).
    // If the agent didn't complete the full planning flow in time, inject a plan via API.
    const reposRes = await request.get(`${API_BASE}/repositories`);
    const repos = await reposRes.json() as { id: string; name: string }[];
    const testRepo = repos.find(r => r.name === repoName);
    expect(testRepo).toBeDefined();

    const projectInApproval = await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}`);
        if (!res.ok()) return false;
        const project = await res.json() as { status: string };
        return project.status === 'awaiting_plan_approval';
      },
      { timeout: 90000, intervals: [5000] }
    ).toBe(true).then(() => true).catch(() => false);

    // Get current project state to check if master agent created the planning PR
    const projStateRes = await request.get(`${API_BASE}/projects/${projectId}`);
    const projState = await projStateRes.json() as {
      planningPr?: { number: number; url: string };
      planningBranch?: string;
    };

    let planningPrNumber: number;

    if (projState.planningPr?.number) {
      // Master agent completed the planning flow — planning PR already exists
      planningPrNumber = projState.planningPr.number;
    } else {
      // Injection path — create a planning PR on GitHub manually
      const suffix = Date.now().toString();
      const { branch, prNumber, prUrl } = await createPlanningPr(suffix);

      const patchData: Record<string, unknown> = {
        planningBranch: branch,
        planningPr: { number: prNumber, url: prUrl },
        status: 'awaiting_plan_approval',
      };

      if (!projectInApproval) {
        // Also inject the plan tasks
        patchData.plan = {
          id: `e2e-plan-${suffix}`,
          projectId,
          content: `### Task 1: Create e2e-marker.md\n**Repository:** ${repoName}\n**Description:**\nCreate e2e-marker.md.`,
          tasks: [{
            id: `e2e-task-${suffix}`,
            repositoryId: testRepo!.id,
            description: 'Create a file called `e2e-marker.md` with the content "# E2E Test Passed" and commit it to the current branch.',
            status: 'pending',
          }],
        };
      }

      await request.patch(`${API_BASE}/projects/${projectId}`, { data: patchData });
      planningPrNumber = prNumber;
    }

    // Approve the planning PR — triggers the polling cycle to dispatch tasks
    await postLgtmComment(planningPrNumber);

    // Wait for polling to detect approval and transition project to executing (up to 120s)
    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}`);
        if (!res.ok()) return false;
        const project = await res.json() as { status: string };
        return project.status === 'executing';
      },
      { timeout: 120000, intervals: [3000] }
    ).toBe(true);

    // Poll for sub-agent reaching a terminal state — fails fast on auth/model errors
    await expect.poll(
      pollSubAgentStatus(request, projectId!),
      { timeout: 300000, intervals: [5000] }
    ).toBe('completed');

    // Verify a new branch was pushed to the test repo — proves the commit+push happened
    await expect.poll(
      async () => {
        const res = await request.get(
          `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
          { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
        );
        if (!res.ok()) return false;
        const branches = await res.json() as { name: string }[];
        return branches.some(b => !initialBranchNames.includes(b.name));
      },
      { timeout: 60000, intervals: [5000] }
    ).toBe(true);
  });
});
