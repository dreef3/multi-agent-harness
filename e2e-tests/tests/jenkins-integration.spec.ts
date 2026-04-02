/**
 * E2E integration tests for Jenkins log fetching via GET /api/ci/logs.
 *
 * These tests require a real Jenkins instance running at JENKINS_URL (set
 * to http://localhost:8080 by the E2E workflow which starts Jenkins in Docker).
 * They are skipped automatically when JENKINS_URL is not set.
 */
import { test, expect } from '@playwright/test';

const JENKINS_URL = process.env.JENKINS_URL ?? '';
const API_BASE = process.env.HARNESS_API_URL || 'http://localhost:3000/api';
// In Docker, the harness reaches Jenkins via host.docker.internal
const JENKINS_URL_FROM_HARNESS = process.env.JENKINS_URL_FROM_HARNESS ?? JENKINS_URL;

test.describe('Jenkins CI Integration', () => {
  test.beforeAll(() => {
    if (!JENKINS_URL) {
      console.log('JENKINS_URL not set — skipping Jenkins integration tests');
    }
  });

  test('GET /api/ci/logs returns real Jenkins console output', async ({ request }) => {
    test.skip(!JENKINS_URL, 'JENKINS_URL not configured');
    test.setTimeout(3 * 60 * 1000); // 3 min — Jenkins build can take ~30s

    // 1. Trigger a build of the pre-configured test-job
    const triggerRes = await fetch(`${JENKINS_URL}/job/harness-test-job/build`, {
      method: 'POST',
    });
    // 201 = queued, 200 = also accepted
    expect([200, 201]).toContain(triggerRes.status);

    // 2. Poll until the build starts and we can get a build number
    let buildNumber: number | null = null;
    await expect.poll(async () => {
      const r = await fetch(`${JENKINS_URL}/job/harness-test-job/lastBuild/api/json`);
      if (!r.ok) return null;
      const data = await r.json() as { number: number; building: boolean };
      buildNumber = data.number;
      return data.number;
    }, { intervals: [3_000, 5_000, 10_000], timeout: 60_000, message: 'Jenkins build should start' })
      .not.toBeNull();

    // 3. Wait for the build to finish
    await expect.poll(async () => {
      const r = await fetch(`${JENKINS_URL}/job/harness-test-job/${buildNumber}/api/json`);
      if (!r.ok) return false;
      const data = await r.json() as { building: boolean };
      return !data.building;
    }, { intervals: [5_000, 10_000], timeout: 90_000, message: 'Jenkins build should complete' })
      .toBe(true);

    // 4. Call the harness /api/ci/logs endpoint with the Jenkins build URL
    const buildUrl = `${JENKINS_URL_FROM_HARNESS}/job/harness-test-job/${buildNumber}/`;
    const logsRes = await request.get(`${API_BASE}/ci/logs`, {
      params: { buildUrl },
    });
    expect(logsRes.ok()).toBeTruthy();

    const body = await logsRes.json() as { logs: string };
    expect(typeof body.logs).toBe('string');

    // 5. Verify the build output appears in the logs
    expect(body.logs).toContain('HARNESS_CI_TEST_MARKER');
  });

  test('GET /api/ci/logs returns 400 when buildUrl is missing', async ({ request }) => {
    const res = await request.get(`${API_BASE}/ci/logs`);
    expect(res.status()).toBe(400);
  });

  test('GET /api/ci/logs returns 500 when CI URL is not reachable', async ({ request }) => {
    // Use a URL that matches JENKINS_URL pattern but points to a dead port
    if (!JENKINS_URL) {
      // Fallback: use any URL when JENKINS_URL is not set — should 500 with "No CI backend"
      const res = await request.get(`${API_BASE}/ci/logs`, {
        params: { buildUrl: 'http://localhost:19999/job/test/1/' },
      });
      expect(res.status()).toBe(500);
      return;
    }
    // Use JENKINS_URL but with a non-existent job
    const res = await request.get(`${API_BASE}/ci/logs`, {
      params: { buildUrl: `${JENKINS_URL_FROM_HARNESS}/job/does-not-exist/999/` },
    });
    // Should return 500 because Jenkins will return 404 which we re-raise
    expect(res.status()).toBe(500);
  });
});
