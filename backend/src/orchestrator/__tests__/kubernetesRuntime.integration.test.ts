import { describe, it, expect, beforeAll } from "vitest";
import { KubernetesContainerRuntime } from "../kubernetesRuntime.js";

const SKIP = process.env.CONTAINER_RUNTIME !== "kubernetes";

describe.skipIf(SKIP)("KubernetesContainerRuntime (integration)", () => {
  let runtime: KubernetesContainerRuntime;

  beforeAll(() => {
    runtime = new KubernetesContainerRuntime(process.env.K8S_NAMESPACE ?? "default");
  });

  it("creates and starts a Job, then removes it", async () => {
    const id = await runtime.createContainer({
      sessionId: "test-session-1",
      image: "busybox:latest",
      name: "harness-test-job",
      env: ["FOO=bar"],
      binds: [],
      memoryBytes: 128 * 1024 * 1024,
      nanoCpus: 500_000_000,
      networkMode: "default",
    });

    expect(id).toMatch(/^harness-test-job/);

    await new Promise<void>((resolve) => {
      runtime.watchExit(id, (code) => {
        expect(code).toBe(0);
        resolve();
      });
    });

    const status = await runtime.getStatus(id);
    expect(status).toBe("exited");

    await runtime.removeContainer(id);
    const afterStatus = await runtime.getStatus(id);
    expect(afterStatus).toBe("unknown");
  }, 60_000);
});
