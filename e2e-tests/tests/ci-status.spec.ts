/**
 * E2E tests for CI status tools (build-status and build-logs endpoints).
 *
 * These tests rely on the GitHub Actions workflow at
 * dreef3/multi-agent-harness-test-repo/.github/workflows/ci.yml which runs
 * on every push. A branch is created, check runs appear, and the harness
 * API is verified to surface them correctly.
 */
import { test, expect } from '@playwright/test';
import {
  API_BASE,
  GH_TOKEN,
  GH_HEADERS,
  TEST_REPO_OWNER,
  TEST_REPO_NAME,
  TEST_REPO_HTTPS_URL,
  cleanupNewBranches,
  seedTestRepo,
  deleteTestRepo,
} from './helpers';

test.describe('CI Status Tools', () => {
  let repoName: string;
  let initialBranchNames: string[] = [];

  test.beforeEach(async ({ request }, testInfo) => {
    repoName = `E2E CI Status Repo ${testInfo.parallelIndex}`;

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

    await seedTestRepo(request, repoName);
  });

  test.afterEach(async ({ request }) => {
    await deleteTestRepo(request, repoName);
    await cleanupNewBranches(initialBranchNames);
  });

  test('build-status returns valid shape for a branch with CI', async ({ request }) => {
    test.setTimeout(5 * 60 * 1000); // 5 min — allows GH Actions check runs to appear

    // 1. Create a branch in the test repo to trigger the CI workflow
    const refRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/main`,
      { headers: GH_HEADERS }
    );
    expect(refRes.ok).toBeTruthy();
    const refData = await refRes.json() as { object: { sha: string } };
    const sha = refData.object.sha;

    const branch = `harness/e2e-ci-${Date.now()}`;

    // Create branch
    const createBranchRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs`,
      {
        method: 'POST',
        headers: GH_HEADERS,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      }
    );
    expect(createBranchRes.ok).toBeTruthy();

    // Push a file to trigger the CI workflow
    await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/contents/.harness/ci-e2e.md`,
      {
        method: 'PUT',
        headers: GH_HEADERS,
        body: JSON.stringify({
          message: 'chore: trigger CI for e2e test',
          content: Buffer.from('# CI E2E trigger').toString('base64'),
          branch,
        }),
      }
    );

    // 2. Look up the repository ID in the harness
    const reposRes = await request.get(`${API_BASE}/repositories`);
    expect(reposRes.ok()).toBeTruthy();
    const repos = await reposRes.json() as { id: string; name: string }[];
    const repo = repos.find(r => r.name === repoName);
    expect(repo).toBeDefined();

    // 3. Register a PR record for this branch via POST /api/pull-requests
    const prRes = await request.post(`${API_BASE}/pull-requests`, {
      data: {
        repositoryId: repo!.id,
        branch,
        externalId: branch,
        url: `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/tree/${branch}`,
        provider: 'github',
      },
    });
    expect(prRes.ok()).toBeTruthy();
    const pr = await prRes.json() as { id: string };
    expect(pr.id).toBeTruthy();

    // 4. Poll build-status until checks appear (GH Actions takes ~30-60s to register)
    let statusResult: { state: string; checks: { name: string; status: string; buildId: string }[] } | null = null;
    await expect.poll(async () => {
      const res = await request.get(`${API_BASE}/pull-requests/${pr.id}/build-status`);
      if (!res.ok()) return null;
      statusResult = await res.json();
      // Return state — once check runs appear the state won't be "unknown" with empty checks
      return statusResult?.state;
    }, {
      intervals: [5_000, 10_000, 15_000, 20_000, 30_000],
      timeout: 4 * 60 * 1000,
      message: 'Expected check runs to appear on the branch',
    }).not.toBe('unknown');

    // 5. Verify the response shape
    expect(statusResult).not.toBeNull();
    expect(statusResult!.state).toMatch(/^(pending|success|failure|unknown)$/);
    expect(Array.isArray(statusResult!.checks)).toBe(true);

    // We expect at least one check run from the CI workflow
    expect(statusResult!.checks.length).toBeGreaterThan(0);
    const check = statusResult!.checks[0];
    expect(check.name).toBeTruthy();
    expect(check.status).toMatch(/^(pending|success|failure)$/);
    expect(check.buildId).toBeTruthy();
  });

  test('build-logs returns log string for a completed check run', async ({ request }) => {
    test.setTimeout(5 * 60 * 1000);

    // Create branch and push to trigger CI
    const refRes = await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs/heads/main`,
      { headers: GH_HEADERS }
    );
    const refData = await refRes.json() as { object: { sha: string } };
    const branch = `harness/e2e-logs-${Date.now()}`;

    await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/git/refs`,
      {
        method: 'POST',
        headers: GH_HEADERS,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: refData.object.sha }),
      }
    );

    await fetch(
      `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/contents/.harness/logs-e2e.md`,
      {
        method: 'PUT',
        headers: GH_HEADERS,
        body: JSON.stringify({
          message: 'chore: trigger CI for build-logs e2e test',
          content: Buffer.from('# Logs E2E trigger').toString('base64'),
          branch,
        }),
      }
    );

    const reposRes = await request.get(`${API_BASE}/repositories`);
    const repos = await reposRes.json() as { id: string; name: string }[];
    const repo = repos.find(r => r.name === repoName);

    const prRes = await request.post(`${API_BASE}/pull-requests`, {
      data: { repositoryId: repo!.id, branch, externalId: branch },
    });
    const pr = await prRes.json() as { id: string };

    // Poll until a check run with a buildId appears
    let buildId: string | null = null;
    await expect.poll(async () => {
      const res = await request.get(`${API_BASE}/pull-requests/${pr.id}/build-status`);
      if (!res.ok()) return null;
      const status = await res.json() as { checks: { buildId: string }[] };
      const check = status.checks?.[0];
      buildId = check?.buildId ?? null;
      return buildId;
    }, {
      intervals: [5_000, 10_000, 15_000, 20_000, 30_000],
      timeout: 4 * 60 * 1000,
      message: 'Expected a check run with a buildId to appear',
    }).not.toBeNull();

    // Call build-logs
    const logsRes = await request.get(`${API_BASE}/pull-requests/${pr.id}/build-logs/${buildId}`);
    expect(logsRes.ok()).toBeTruthy();
    const logsBody = await logsRes.json() as { logs: string };
    expect(typeof logsBody.logs).toBe('string');
  });

  test('build-status returns 404 for unknown PR id', async ({ request }) => {
    const res = await request.get(`${API_BASE}/pull-requests/00000000-0000-0000-0000-000000000000/build-status`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/pull-requests returns 400 without required fields', async ({ request }) => {
    const res = await request.post(`${API_BASE}/pull-requests`, {
      data: { branch: 'main' }, // missing repositoryId
    });
    expect(res.status()).toBe(400);
  });
});
