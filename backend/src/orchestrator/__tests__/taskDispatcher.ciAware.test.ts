import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BuildStatus } from "../../connectors/types.js";

// Mock the connector registry
vi.mock("../../connectors/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../connectors/types.js")>();
  return {
    ...actual,
    getConnector: vi.fn(),
  };
});

import { getConnector } from "../../connectors/types.js";
import { TaskDispatcher } from "../taskDispatcher.js";
import type { ContainerRuntime } from "../containerRuntime.js";

function makeMockRuntime(): ContainerRuntime {
  return {
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    getStatus: vi.fn(),
    watchExit: vi.fn(),
    streamLogs: vi.fn(),
    listByLabel: vi.fn(),
  };
}

function makeMockConnector(statuses: BuildStatus[]) {
  let callCount = 0;
  return {
    getBuildStatus: vi.fn().mockImplementation(async () => {
      const result = statuses[Math.min(callCount, statuses.length - 1)];
      callCount++;
      return result;
    }),
  };
}

describe("TaskDispatcher.waitForPrCi", () => {
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    dispatcher = new TaskDispatcher(makeMockRuntime());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const makeRepo = () => ({
    provider: "github",
    cloneUrl: "https://github.com/org/repo.git",
    providerConfig: { owner: "org", repo: "repo" },
  } as any);

  it("returns passed=true when CI is immediately successful", async () => {
    const mock = makeMockConnector([
      { state: "success", checks: [{ name: "test", status: "success", buildId: "1", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    // @ts-expect-error: accessing private method for test
    const result = await dispatcher.waitForPrCi(makeRepo(), "feature/test", 60_000);

    expect(result.passed).toBe(true);
    expect(result.status.state).toBe("success");
  });

  it("returns passed=false when CI immediately fails", async () => {
    const mock = makeMockConnector([
      { state: "failure", checks: [{ name: "test-backend", status: "failure", buildId: "2", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    // @ts-expect-error
    const result = await dispatcher.waitForPrCi(makeRepo(), "feature/test", 60_000);

    expect(result.passed).toBe(false);
    expect(result.status.checks[0].name).toBe("test-backend");
  });

  it("polls until success after pending state", async () => {
    const mock = makeMockConnector([
      { state: "pending", checks: [{ name: "test", status: "pending", buildId: "3", url: "" }] },
      { state: "pending", checks: [{ name: "test", status: "pending", buildId: "3", url: "" }] },
      { state: "success", checks: [{ name: "test", status: "success", buildId: "3", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const promise = (dispatcher as any).waitForPrCi(makeRepo(), "feature/test", 120_000);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;

    expect(result.passed).toBe(true);
    expect(mock.getBuildStatus).toHaveBeenCalledTimes(3);
  });

  it("times out and returns passed=false", async () => {
    const mock = makeMockConnector([
      { state: "pending", checks: [{ name: "test", status: "pending", buildId: "4", url: "" }] },
    ]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    const promise = (dispatcher as any).waitForPrCi(makeRepo(), "feature/test", 30_000);
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(result.passed).toBe(false);
  });

  it("treats unknown state with no checks as passing", async () => {
    const mock = makeMockConnector([{ state: "unknown", checks: [] }]);
    (getConnector as ReturnType<typeof vi.fn>).mockReturnValue(mock);

    // @ts-expect-error
    const result = await dispatcher.waitForPrCi(makeRepo(), "feature/no-ci", 60_000);

    expect(result.passed).toBe(true);
  });
});
