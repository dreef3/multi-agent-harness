import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const TEST_REPO_OWNER = 'dreef3';
const TEST_REPO_NAME = 'multi-agent-harness-test-repo';
const TEST_REPO_HTTPS_URL = `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}.git`;
const GH_HEADERS = {
  Authorization: `token ${GH_TOKEN}`,
  'User-Agent': 'harness-e2e',
  'Content-Type': 'application/json',
};

/**
 * Create a branch with one commit in the test repo and open a PR.
 * Returns the branch name, PR number, and PR URL.
 */
async function createPlanningPr(suffix: string): Promise<{ branch: string; prNumber: number; prUrl: string }> {
  const refRes = await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/main`,
    { headers: GH_HEADERS }
  );
  const refData = await refRes.json() as { object: { sha: string } };
  const sha = refData.object.sha;

  const branch = `harness/e2e-plan-${suffix}`;

  await fetch(`https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs`, {
    method: 'POST',
    headers: GH_HEADERS,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });

  await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/contents/.harness/e2e-${suffix}.md`,
    {
      method: 'PUT',
      headers: GH_HEADERS,
      body: JSON.stringify({
        message: 'chore: e2e test planning document',
        content: Buffer.from('# E2E test plan').toString('base64'),
        branch,
      }),
    }
  );

  const prRes = await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls`,
    {
      method: 'POST',
      headers: GH_HEADERS,
      body: JSON.stringify({ title: '[Harness] E2E Test', head: branch, base: 'main', body: 'E2E test' }),
    }
  );
  const pr = await prRes.json() as { number: number; html_url: string };
  return { branch, prNumber: pr.number, prUrl: pr.html_url };
}

/** Post a PR approval on a GitHub PR to trigger the harness polling flow. */
async function postPrApproval(prNumber: number): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      headers: GH_HEADERS,
      body: JSON.stringify({ event: 'APPROVE', body: 'Approved via E2E test' }),
    }
  );
}

test.describe('Review Comment Fix-Run Flow', () => {
  let initialBranchNames: string[] = [];

  test.beforeEach(async ({ request }) => {
    // Record current branches so we can clean up new ones in afterEach
    const branchRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
      { headers: { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' } }
    );
    if (branchRes.ok) {
      const branches = await branchRes.json() as { name: string }[];
      if (Array.isArray(branches)) {
        initialBranchNames = branches.map(b => b.name);
      }
    }

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
    if (repos.ok()) {
      const data = await repos.json();
      for (const repo of (data as { id: string; name: string }[])) {
        if (repo.name === 'E2E Test Repo') {
          await request.delete(`${API_BASE}/repositories/${repo.id}`);
        }
      }
    }

    // Clean up any GitHub branches created during the test to prevent accumulation.
    const ghHeaders = { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' };
    const branchRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
      { headers: ghHeaders }
    );
    if (branchRes.ok) {
      const branches = await branchRes.json() as { name: string }[];
      for (const branch of branches) {
        if (!initialBranchNames.includes(branch.name)) {
          await fetch(
            `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/${branch.name}`,
            { method: 'DELETE', headers: ghHeaders }
          );
        }
      }
    }
  });

  test('fix-run marks comments fixed and pushes new commit', async ({ request }) => {
    test.setTimeout(20 * 60 * 1000); // 20 minutes — covers two sub-agent runs

    // ── 1. Get the seeded repository ID ──────────────────────────────────────
    const reposRes = await request.get(`${API_BASE}/repositories`);
    const repos = await reposRes.json() as { id: string; name: string }[];
    const testRepo = repos.find(r => r.name === 'E2E Test Repo');
    expect(testRepo).toBeDefined();
    const repoId = testRepo!.id;

    // ── 2. Create a project linked to the repository ─────────────────────────
    const projectRes = await request.post(`${API_BASE}/projects`, {
      data: {
        name: `Review Flow E2E ${Date.now()}`,
        description: 'E2E test for review comment fix-run',
        repositoryIds: [repoId],
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string };
    const projectId = project.id;

    // ── 3. Create a planning PR on GitHub and inject the plan ─────────────────
    const suffix = Date.now().toString();
    const taskId = `e2e-task-${suffix}`;
    const { branch, prNumber, prUrl } = await createPlanningPr(suffix);

    await request.patch(`${API_BASE}/projects/${projectId}`, {
      data: {
        planningBranch: branch,
        planningPr: { number: prNumber, url: prUrl },
        plan: {
          id: `e2e-plan-${suffix}`,
          projectId,
          content: '### Task 1: Create review-flow-marker.md\n**Repository:** E2E Test Repo\n**Description:**\nCreate review-flow-marker.md.',
          tasks: [{
            id: taskId,
            repositoryId: repoId,
            description: 'Create a file called `review-flow-marker.md` with the content "# Review Flow Marker" and commit it to the current branch.',
            status: 'pending',
          }],
        },
        status: 'awaiting_plan_approval',
      },
    });

    // ── 4. Post PR approval — triggers polling to detect plan approval and dispatch ──
    await postPrApproval(prNumber);

    // ──5. Wait for polling to detect approval and transition to executing ────────
    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}`);
        if (!res.ok()) return false;
        const proj = await res.json() as { status: string };
        return proj.status === 'executing';
      },
      { timeout: 120000, intervals: [5000] }
    ).toBe(true);

    // ── 6. Poll for sub-agent session completing ──────────────────────────────
    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}/agents`);
        if (!res.ok()) return false;
        const sessions = await res.json() as { type: string; status: string }[];
        return sessions.some(s => s.type === 'sub' && s.status === 'completed');
      },
      { timeout: 10 * 60 * 1000, intervals: [10000] }
    ).toBe(true);

    // ── 7. Poll for PR to appear in harness ──────────────────────────────────
    let prId: string | undefined;
    let prBranch: string | undefined;
    let prNumber2: number | undefined;

    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/pull-requests/project/${projectId}`);
        if (!res.ok()) return false;
        const prs = await res.json() as { id: string; branch: string; externalId: string }[];
        if (prs.length === 0) return false;
        prId = prs[0].id;
        prBranch = prs[0].branch;
        prNumber2 = parseInt(prs[0].externalId, 10);
        return true;
      },
      { timeout: 60000, intervals: [5000] }
    ).toBe(true);

    expect(prId).toBeDefined();
    expect(prBranch).toBeDefined();
    expect(prNumber2).toBeGreaterThan(0);

    // ── 8. Record baseline commit count on the PR branch ─────────────────────
    const baselineCommitsRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/commits?sha=${prBranch}&per_page=100`,
      { headers: GH_HEADERS }
    );
    const baselineCommits = await baselineCommitsRes.json() as { sha: string }[];
    const baselineCount = baselineCommits.length;

    // ── 9. Post a generic PR-level comment via GitHub API ────────────────────
    const commentRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${prNumber2}/comments`,
      {
        method: 'POST',
        headers: GH_HEADERS,
        body: JSON.stringify({ body: 'Please add a brief comment explaining what this file is for.' }),
      }
    );
    expect(commentRes.ok).toBe(true);

    // ── 10. Sync comments into harness ─────────────────────────────────────────
    const syncRes = await request.post(`${API_BASE}/pull-requests/${prId}/sync`);
    expect(syncRes.ok()).toBe(true);
    const syncData = await syncRes.json() as { synced: number };
    expect(syncData.synced).toBeGreaterThan(0);

    // Verify pending comments appeared (getPendingComments returns status='pending')
    const pendingBeforeRes = await request.get(`${API_BASE}/pull-requests/${prId}`);
    expect(pendingBeforeRes.ok()).toBe(true);
    const pendingBefore = await pendingBeforeRes.json() as { comments: { status: string }[] };
    expect(pendingBefore.comments.length).toBeGreaterThan(0);

    // ── 11. Trigger fix-run (blocks until container exits) ───────────────────
    const fixRes = await request.post(
      `${API_BASE}/pull-requests/${prId}/fix`,
      { timeout: 15 * 60 * 1000 }
    );
    expect(fixRes.ok()).toBe(true);
    const fixData = await fixRes.json() as { success: boolean };
    expect(fixData.success).toBe(true);

    // ── 12. Verify comments are now "fixed" ───────────────────────────────────
    const prDetailRes = await request.get(`${API_BASE}/pull-requests/${prId}`);
    expect(prDetailRes.ok()).toBe(true);
    const prDetail = await prDetailRes.json() as { comments: { status: string }[] };
    expect(prDetail.comments.length).toBe(0); // all moved from pending → fixed

    // ── 13. Verify new commit pushed to PR branch ─────────────────────────────
    await expect.poll(
      async () => {
        const res = await fetch(
          `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/commits?sha=${prBranch}&per_page=100`,
          { headers: GH_HEADERS }
        );
        if (!res.ok) return false;
        const commits = await res.json() as { sha: string }[];
        return commits.length > baselineCount;
      },
      { timeout: 30000, intervals: [5000] }
    ).toBe(true);
  });
});
