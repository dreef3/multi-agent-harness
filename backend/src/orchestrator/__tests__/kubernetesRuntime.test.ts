import { describe, it, expect, vi, beforeEach } from "vitest";
import { toK8sName, KubernetesContainerRuntime } from "../kubernetesRuntime.js";
import type { AgentContainerSpec } from "../containerRuntime.js";

// ──────────────────────────────────────────────────────────────────────────────
// toK8sName — name sanitization
// ──────────────────────────────────────────────────────────────────────────────

describe("toK8sName", () => {
  it("converts uppercase to lowercase", () => {
    expect(toK8sName("MyJob")).toBe("myjob");
  });

  it("replaces spaces with hyphens", () => {
    expect(toK8sName("my job name")).toBe("my-job-name");
  });

  it("replaces special chars with hyphens", () => {
    expect(toK8sName("job_name.v1@host")).toBe("job-name-v1-host");
  });

  it("trims leading hyphens", () => {
    expect(toK8sName("--leading")).toBe("leading");
  });

  it("trims trailing hyphens", () => {
    expect(toK8sName("trailing--")).toBe("trailing");
  });

  it("trims both leading and trailing hyphens", () => {
    expect(toK8sName("--both--")).toBe("both");
  });

  it("truncates names longer than 52 characters", () => {
    const long = "a".repeat(60);
    const result = toK8sName(long);
    expect(result.length).toBeLessThanOrEqual(52);
    expect(result).toBe("a".repeat(52));
  });

  it("handles all-invalid characters producing empty-like result", () => {
    // After replacement all chars become '-', then trimmed
    const result = toK8sName("@@@");
    expect(result).toBe("");
  });

  it("preserves valid alphanumeric and hyphen characters", () => {
    expect(toK8sName("valid-name-123")).toBe("valid-name-123");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getStatus — status mapping (tested via mock K8s API)
// ──────────────────────────────────────────────────────────────────────────────

// We mock the k8s module to avoid needing a cluster
vi.mock("@kubernetes/client-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kubernetes/client-node")>();

  class MockBatchV1Api {
    readNamespacedJob = vi.fn();
    createNamespacedJob = vi.fn();
    patchNamespacedJob = vi.fn();
    deleteNamespacedJob = vi.fn();
    listNamespacedJob = vi.fn();
  }

  class MockCoreV1Api {
    listNamespacedPod = vi.fn();
    readNamespacedPod = vi.fn();
    readNamespacedPodLog = vi.fn();
  }

  class MockKubeConfig {
    loadFromDefault = vi.fn();
    makeApiClient = vi.fn((ApiClass: unknown) => {
      if (ApiClass === MockBatchV1Api) return new MockBatchV1Api();
      return new MockCoreV1Api();
    });
    getCurrentCluster = vi.fn().mockReturnValue({ server: "http://localhost:8080" });
  }

  return {
    ...actual,
    KubeConfig: MockKubeConfig,
    BatchV1Api: MockBatchV1Api,
    CoreV1Api: MockCoreV1Api,
  };
});

describe("KubernetesContainerRuntime.getStatus", () => {
  let runtime: KubernetesContainerRuntime;
  let mockBatchApi: {
    readNamespacedJob: ReturnType<typeof vi.fn>;
    createNamespacedJob: ReturnType<typeof vi.fn>;
    patchNamespacedJob: ReturnType<typeof vi.fn>;
    deleteNamespacedJob: ReturnType<typeof vi.fn>;
    listNamespacedJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const k8s = await import("@kubernetes/client-node");
    runtime = new KubernetesContainerRuntime("default");
    // Access the private batchV1 via type assertion for test purposes
    mockBatchApi = (runtime as unknown as { batchV1: typeof mockBatchApi }).batchV1;
  });

  it('returns "exited" when succeeded > 0', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce({ status: { succeeded: 1 } });
    const status = await runtime.getStatus("test-job");
    expect(status).toBe("exited");
  });

  it('returns "stopped" when failed > 0', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce({ status: { failed: 1 } });
    const status = await runtime.getStatus("test-job");
    expect(status).toBe("stopped");
  });

  it('returns "running" when active > 0', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce({ status: { active: 1 } });
    const status = await runtime.getStatus("test-job");
    expect(status).toBe("running");
  });

  it('returns "unknown" when status is empty', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce({ status: {} });
    const status = await runtime.getStatus("test-job");
    expect(status).toBe("unknown");
  });

  it('returns "unknown" when job is not found (404)', async () => {
    const err = new Error("Not Found");
    mockBatchApi.readNamespacedJob.mockRejectedValueOnce(err);
    const status = await runtime.getStatus("test-job");
    expect(status).toBe("unknown");
  });

  it('returns "unknown" when status is null', async () => {
    mockBatchApi.readNamespacedJob.mockResolvedValueOnce({ status: null });
    const status = await runtime.getStatus("test-job");
    expect(status).toBe("unknown");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Env string parsing — KEY=VALUE format
// ──────────────────────────────────────────────────────────────────────────────

describe("KubernetesContainerRuntime.createContainer env parsing", () => {
  let runtime: KubernetesContainerRuntime;
  let mockBatchApi: {
    createNamespacedJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    runtime = new KubernetesContainerRuntime("default");
    mockBatchApi = (runtime as unknown as { batchV1: typeof mockBatchApi }).batchV1;
    mockBatchApi.createNamespacedJob.mockResolvedValue({});
  });

  it("splits DATABASE_URL correctly at the first = sign", async () => {
    const spec: AgentContainerSpec = {
      sessionId: "sess-1",
      image: "busybox:latest",
      name: "test-job",
      env: ["DATABASE_URL=pg://user:pass@host/db?ssl=true"],
      binds: [],
      memoryBytes: 128 * 1024 * 1024,
      nanoCpus: 500_000_000,
      networkMode: "default",
    };

    await runtime.createContainer(spec);

    const callArg = mockBatchApi.createNamespacedJob.mock.calls[0][0];
    const envVars = callArg.body.spec.template.spec.containers[0].env;

    expect(envVars).toContainEqual({
      name: "DATABASE_URL",
      value: "pg://user:pass@host/db?ssl=true",
    });
  });

  it("handles env var without value (no = sign)", async () => {
    const spec: AgentContainerSpec = {
      sessionId: "sess-2",
      image: "busybox:latest",
      name: "test-job-2",
      env: ["BARE_VAR"],
      binds: [],
      memoryBytes: 128 * 1024 * 1024,
      nanoCpus: 500_000_000,
      networkMode: "default",
    };

    await runtime.createContainer(spec);

    const callArg = mockBatchApi.createNamespacedJob.mock.calls[0][0];
    const envVars = callArg.body.spec.template.spec.containers[0].env;

    expect(envVars).toContainEqual({ name: "BARE_VAR", value: "" });
  });

  it("handles multiple env vars correctly", async () => {
    const spec: AgentContainerSpec = {
      sessionId: "sess-3",
      image: "busybox:latest",
      name: "test-job-3",
      env: ["FOO=bar", "BAZ=qux=with=equals"],
      binds: [],
      memoryBytes: 128 * 1024 * 1024,
      nanoCpus: 500_000_000,
      networkMode: "default",
    };

    await runtime.createContainer(spec);

    const callArg = mockBatchApi.createNamespacedJob.mock.calls[0][0];
    const envVars = callArg.body.spec.template.spec.containers[0].env;

    expect(envVars).toContainEqual({ name: "FOO", value: "bar" });
    expect(envVars).toContainEqual({ name: "BAZ", value: "qux=with=equals" });
  });
});
