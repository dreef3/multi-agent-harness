import { test, expect } from './fixtures';
import {
  API_BASE,
  GH_TOKEN,
  TEST_REPO_OWNER,
  TEST_REPO_NAME,
  approvePlanningPr,
  seedTestRepo,
  deleteTestRepo,
  pollSubAgentStatus,
} from './helpers';

test.describe('Repository Configuration Flow', () => {
  let branchesCreatedByTest: string[] = [];
  let repoName: string;

  test.beforeEach(async ({ request }, testInfo) => {
    // Use worker-unique repo name so parallel workers don't clobber each other's repo.
    repoName = `E2E Test Repo ${testInfo.parallelIndex}`;
    branchesCreatedByTest = [];
    await seedTestRepo(request, repoName);
  });

  test.afterEach(async ({ request }) => {
    await deleteTestRepo(request, repoName);
    const ghHeaders = { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' };
    for (const branch of branchesCreatedByTest) {
      await fetch(
        `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/${branch}`,
        { method: 'DELETE', headers: ghHeaders }
      ).catch(() => {});
    }
  });

  test('create project with repository and verify sub-agent pushes a branch', async ({ page, request, agentConfig }) => {
    test.setTimeout(20 * 60 * 1000); // 20 minutes — covers planning (5 min) + execution cycle (sub-agent can take ~10 min)

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

    // Apply agent config for this Playwright project variant (planning + implementation agent types)
    if (agentConfig.planning || agentConfig.implementation) {
      await request.put(`${API_BASE}/projects/${projectId}/agent-config`, {
        data: {
          planningAgent: { type: agentConfig.planning || 'copilot' },
          implementationAgent: { type: agentConfig.implementation || 'copilot' },
        },
      });
    }

    // Send a task that exercises the full planning workflow in one shot.
    // Explicitly requests write_planning_document calls so the agent does not
    // stop at the LGTM gate waiting for user confirmation.
    const taskMessage = [
      'Complete the full planning workflow in ONE response — no clarifying questions needed.',
      '',
      'Task: In the "E2E Test Repo" repository, create a file called `e2e-marker.md`',
      'with the single line "# E2E Test Passed". Commit it to a new branch.',
      '',
      'Write the plan using EXACTLY this format:',
      '',
      '### Task 1: Create e2e-marker.md',
      '**Repository:** E2E Test Repo',
      '**Description:**',
      'Create a file called `e2e-marker.md` with the single line "# E2E Test Passed". Commit it to a new branch.',
      '',
      'After writing the plan, call write_planning_document TWICE to save it:',
      '1. Call with type="spec" and the plan above as the content',
      '2. Call with type="plan" and the same plan content',
    ].join('\n');

    await page.getByPlaceholder(/type your message/i).fill(taskMessage);
    await page.getByRole('button', { name: /send/i }).click();

    // Wait for agent response to appear in the chat
    await expect(page.locator('.bg-gray-800').first()).toBeVisible({ timeout: 120000 });

    // Wait for the project to reach awaiting_plan_approval (agent wrote spec + plan).
    // Allow up to 8 minutes — the agent needs two full turns on slow CI runners,
    // and the copilot-copilot variant can take 5+ minutes per turn under load.
    const projectInApproval = await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}`);
        if (!res.ok()) return false;
        const project = await res.json() as { status: string };
        return project.status === 'awaiting_plan_approval';
      },
      { timeout: 480000, intervals: [5000] }
    ).toBe(true).then(() => true).catch(() => false);

    // Get current project state — agent must have created the planning PR itself.
    // Fallback injection is explicitly prohibited: it hid real planning-agent failures.
    const projStateRes = await request.get(`${API_BASE}/projects/${projectId}`);
    const projState = await projStateRes.json() as {
      planningPr?: { number: number; url: string };
      planningBranch?: string;
    };

    expect(projectInApproval,
      'Project must reach awaiting_plan_approval via the planning agent (no injection fallback)'
    ).toBe(true);
    expect(projState.planningPr?.number,
      'Agent must create the planning PR via write_planning_document — fake injection shortcut is not allowed'
    ).toBeDefined();

    const planningPrNumber = projState.planningPr!.number;
    if (projState.planningBranch) branchesCreatedByTest.push(projState.planningBranch);

    // Approve the planning PR — triggers the polling cycle to dispatch tasks
    await approvePlanningPr(planningPrNumber);

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

    // Snapshot branches now (before sub-agent runs) to detect only branches it pushes.
    const branchSnapshotBeforeExecution = new Set<string>(branchesCreatedByTest);
    const snapshotRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
      { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
    );
    if (snapshotRes.ok) {
      const snapshotBranches = await snapshotRes.json() as { name: string }[];
      snapshotBranches.forEach(b => branchSnapshotBeforeExecution.add(b.name));
    }

    // Poll for sub-agent reaching a terminal state — fails fast on auth/model errors
    await expect.poll(
      pollSubAgentStatus(request, projectId!),
      { timeout: 300000, intervals: [5000] }
    ).toBe('completed');

    // Verify a new branch was pushed to the test repo — proves the commit+push happened
    let agentBranch: string | undefined;
    await expect.poll(
      async () => {
        const res = await fetch(
          `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
          { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
        );
        if (!res.ok) return false;
        const branches = await res.json() as { name: string }[];
        const newBranch = branches.find(b => !branchSnapshotBeforeExecution.has(b.name));
        if (newBranch) { agentBranch = newBranch.name; return true; }
        return false;
      },
      { timeout: 60000, intervals: [5000] }
    ).toBe(true);
    if (agentBranch) branchesCreatedByTest.push(agentBranch);
  });
});
