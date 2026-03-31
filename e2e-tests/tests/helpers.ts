/**
 * Shared helpers for E2E tests that interact with the harness API and GitHub.
 */
import type { APIRequestContext } from '@playwright/test';

export const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
export const GH_TOKEN = process.env.GITHUB_TOKEN || '';
export const TEST_REPO_OWNER = 'dreef3';
export const TEST_REPO_NAME = 'multi-agent-harness-test-repo';
export const TEST_REPO_HTTPS_URL = `https://github.com/${TEST_REPO_OWNER}/${TEST_REPO_NAME}.git`;
export const GH_HEADERS = {
  Authorization: `token ${GH_TOKEN}`,
  'User-Agent': 'harness-e2e',
  'Content-Type': 'application/json',
};

/**
 * Create a branch with one commit in the test repo and open a PR.
 * Returns the branch name, PR number, and PR URL.
 */
export async function createPlanningPr(suffix: string): Promise<{ branch: string; prNumber: number; prUrl: string }> {
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

/** Post a LGTM comment on a GitHub PR to trigger the harness polling flow. */
export async function postLgtmComment(prNumber: number): Promise<void> {
  await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: GH_HEADERS,
      body: JSON.stringify({ body: 'LGTM' }),
    }
  );
}

/**
 * Delete all GitHub branches on the test repo that aren't in the baseline set.
 * Call in afterEach to prevent branch accumulation.
 */
export async function cleanupNewBranches(initialBranchNames: string[]): Promise<void> {
  const ghHeaders = { Authorization: `token ${GH_TOKEN}`, 'User-Agent': 'harness-e2e' };
  const branchRes = await fetch(
    `https://api.github.com/repos/${TEST_REPO_OWNER}/${TEST_REPO_NAME}/branches?per_page=100`,
    { headers: ghHeaders }
  );
  if (!branchRes.ok) return;
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

/**
 * Seed the test repository into the harness under a given name.
 * Use a worker-unique name (e.g. `E2E Test Repo ${testInfo.parallelIndex}`) to
 * allow parallel test workers to operate on isolated harness repositories.
 */
export async function seedTestRepo(request: APIRequestContext, repoName: string): Promise<void> {
  await request.post(`${API_BASE}/repositories`, {
    data: {
      name: repoName,
      provider: 'github',
      providerConfig: { owner: TEST_REPO_OWNER, repo: TEST_REPO_NAME },
      defaultBranch: 'main',
      cloneUrl: TEST_REPO_HTTPS_URL,
    },
  });
}

/** Delete the named test repository from the harness. */
export async function deleteTestRepo(request: APIRequestContext, repoName: string): Promise<void> {
  const repos = await request.get(`${API_BASE}/repositories`);
  if (!repos.ok()) return;
  const data = await repos.json();
  for (const repo of (data as { id: string; name: string }[])) {
    if (repo.name === repoName) {
      await request.delete(`${API_BASE}/repositories/${repo.id}`);
    }
  }
}

/**
 * Poll the /agents endpoint until a sub-agent reaches a terminal state.
 * Returns a poll callback suitable for use with expect.poll().toBe('completed').
 * Checking for any terminal state (completed | failed | error) lets the test fail
 * fast instead of waiting the full timeout when auth/model errors cause immediate exit.
 */
export const TERMINAL_STATES = ['completed', 'failed', 'error'];

export function pollSubAgentStatus(request: APIRequestContext, projectId: string) {
  return async () => {
    const res = await request.get(`${API_BASE}/projects/${projectId}/agents`);
    if (!res.ok()) return null;
    const sessions = await res.json() as { type: string; status: string }[];
    const sub = sessions.find(s => s.type === 'sub' && TERMINAL_STATES.includes(s.status));
    return sub?.status ?? null;
  };
}
