import { test, expect } from '@playwright/test';

const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const TEST_REPO_OWNER = 'dreef3';
const TEST_REPO_NAME = 'multi-agent-harness-test-repo';
const TEST_REPO_HTTPS_URL = `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}.git`;
const GH_HEADERS = { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' };

test.describe('Review Comment Fix-Run Flow', () => {
  test.beforeEach(async ({ request }) => {
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

    // ── 3. Inject a plan (skip master agent) ─────────────────────────────────
    const taskId = `e2e-task-${Date.now()}`;
    await request.patch(`${API_BASE}/projects/${projectId}`, {
      data: {
        plan: {
          id: `e2e-plan-${Date.now()}`,
          projectId,
          content: '### Task 1: Create review-flow-marker.md\n**Repository:** E2E Test Repo\n**Description:**\nCreate review-flow-marker.md.',
          tasks: [{
            id: taskId,
            repositoryId: repoId,
            description: 'Create a file called `review-flow-marker.md` with the content "# Review Flow Marker" and commit it to the current branch.',
            status: 'pending',
          }],
          approved: false,
        },
        status: 'awaiting_approval',
      },
    });

    // ── 4. Approve the plan ───────────────────────────────────────────────────
    const approveRes = await request.post(`${API_BASE}/projects/${projectId}/approve`);
    expect(approveRes.ok()).toBe(true);

    // ── 5. Poll for sub-agent session completing ──────────────────────────────
    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/projects/${projectId}/agents`);
        if (!res.ok()) return false;
        const sessions = await res.json() as { type: string; status: string }[];
        return sessions.some(s => s.type === 'sub' && s.status === 'completed');
      },
      { timeout: 10 * 60 * 1000, intervals: [10000] }
    ).toBe(true);

    // ── 6. Poll for PR to appear in harness ──────────────────────────────────
    let prId: string | undefined;
    let prBranch: string | undefined;
    let prNumber: number | undefined;

    await expect.poll(
      async () => {
        const res = await request.get(`${API_BASE}/pull-requests/project/${projectId}`);
        if (!res.ok()) return false;
        const prs = await res.json() as { id: string; branch: string; externalId: string }[];
        if (prs.length === 0) return false;
        prId = prs[0].id;
        prBranch = prs[0].branch;
        prNumber = parseInt(prs[0].externalId, 10);
        return true;
      },
      { timeout: 60000, intervals: [5000] }
    ).toBe(true);

    expect(prId).toBeDefined();
    expect(prBranch).toBeDefined();
    expect(prNumber).toBeGreaterThan(0);

    // ── 7. Record baseline commit count on the PR branch ─────────────────────
    const baselineCommitsRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/commits?sha=${prBranch}&per_page=100`,
      { headers: GH_HEADERS }
    );
    const baselineCommits = await baselineCommitsRes.json() as { sha: string }[];
    const baselineCount = baselineCommits.length;

    // ── 8. Post a generic PR-level comment via GitHub API ────────────────────
    const commentRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${prNumber}/comments`,
      {
        method: 'POST',
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Please add a brief comment explaining what this file is for.' }),
      }
    );
    expect(commentRes.ok).toBe(true);

    // ── 9. Sync comments into harness ─────────────────────────────────────────
    const syncRes = await request.post(`${API_BASE}/pull-requests/${prId}/sync`);
    expect(syncRes.ok()).toBe(true);
    const syncData = await syncRes.json() as { synced: number };
    expect(syncData.synced).toBeGreaterThan(0);

    // ── 10. Trigger fix-run (blocks until container exits) ───────────────────
    // The endpoint awaits runFixRun inline, so a 200 means the container ran and comments are marked.
    const fixRes = await request.post(
      `${API_BASE}/pull-requests/${prId}/fix`,
      { timeout: 15 * 60 * 1000 }
    );
    expect(fixRes.ok()).toBe(true);
    const fixData = await fixRes.json() as { success: boolean };
    expect(fixData.success).toBe(true);

    // ── 11. Verify comments are "fixed" in harness ───────────────────────────
    const prDetailRes = await request.get(`${API_BASE}/pull-requests/${prId}`);
    expect(prDetailRes.ok()).toBe(true);
    const prDetail = await prDetailRes.json() as { comments: { status: string }[] };
    expect(prDetail.comments.length).toBeGreaterThan(0);
    expect(prDetail.comments.every(c => c.status === 'fixed')).toBe(true);

    // ── 12. Verify new commit pushed to PR branch ────────────────────────────
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
