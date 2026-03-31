# Sub-Agent Container Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden sub-agent container security by dropping all Linux capabilities and preventing privilege escalation via `no-new-privileges`, with an opt-in read-only root filesystem controlled by a config flag.

**Architecture:** The change is confined to `containerManager.ts` (the `createSubAgentContainer` function's `HostConfig`) and `config.ts` (one new env var). An opt-in `tmpfs` map is added for writable scratch space when `ReadonlyRootfs=true`. The Dockerode type definitions for `HostConfig` already include `CapDrop`, `SecurityOpt`, `ReadonlyRootfs`, and `Tmpfs`.

**Tech Stack:** Express + TypeScript, Dockerode (`docker.createContainer` HostConfig), better-sqlite3, Bun/Vitest.

---

## Context

**File:** `backend/src/orchestrator/containerManager.ts` lines 86–102
**File:** `backend/src/config.ts`

Current `HostConfig` (lines 91–100):
```typescript
HostConfig: {
  Binds: [`${config.piAgentVolume}:/pi-agent`],
  Memory: config.subAgentMemoryBytes,
  NanoCpus: config.subAgentCpuCount * 1_000_000_000,
  NetworkMode: config.subAgentNetwork,
},
```

No security options are set, so containers run with the default Docker capability set (which includes capabilities like `NET_BIND_SERVICE`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, etc.). A compromised sub-agent can use these to escalate.

---

## Steps

- [ ] **Step 1 — Add `subAgentReadOnlyRootfs` to `config.ts`**

  Read `backend/src/config.ts` to confirm the current last field (line 76: `testRepoUrl`). Add the new config field at the end of the `config` object:

  ```typescript
  // Opt-in: mount sub-agent root filesystem as read-only.
  // Requires tmpfs mounts for /tmp and /workspace.
  subAgentReadOnlyRootfs: process.env.SUB_AGENT_READONLY_ROOTFS === "true",
  ```

  The full addition at the end of `config.ts` (before the closing `}`):

  ```typescript
  export const config = {
    // ... existing fields ...
    testRepoUrl: process.env.TEST_REPO_URL ?? "git@github.com:dreef3/multi-agent-harness-test-repo.git",
    // Opt-in: mount sub-agent root filesystem as read-only.
    // Requires tmpfs mounts for /tmp and /workspace.
    subAgentReadOnlyRootfs: process.env.SUB_AGENT_READONLY_ROOTFS === "true",
  };
  ```

- [ ] **Step 2 — Update `HostConfig` in `createSubAgentContainer`**

  In `backend/src/orchestrator/containerManager.ts`, replace the existing `HostConfig` block (lines 91–100) with the hardened version:

  ```typescript
  HostConfig: {
    Binds: [
      // Shared pi-agent dir so sub-agents can use OAuth tokens (e.g. GitHub Copilot)
      // logged in via the master agent
      `${config.piAgentVolume}:/pi-agent`,
    ],
    Memory: config.subAgentMemoryBytes,
    NanoCpus: config.subAgentCpuCount * 1_000_000_000,
    NetworkMode: config.subAgentNetwork,
    // Security hardening: drop all Linux capabilities and prevent setuid escalation.
    // Note: CapDrop "ALL" still allows git operations — git requires no special capabilities.
    // If a future task requires a specific capability (e.g., DAC_OVERRIDE for volume mount
    // permission issues), add it via CapAdd: ["DAC_OVERRIDE"].
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    // Opt-in read-only root filesystem (SUB_AGENT_READONLY_ROOTFS=true).
    // When enabled, /tmp and /workspace are mounted as tmpfs for writable scratch space.
    ...(config.subAgentReadOnlyRootfs ? {
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=100m",
        "/workspace": "rw,noexec,nosuid,size=2g",
      },
    } : {}),
  },
  ```

  The spread of the conditional block is valid TypeScript — Dockerode's `ContainerCreateOptions["HostConfig"]` accepts `Tmpfs?: { [key: string]: string }`.

- [ ] **Step 3 — Verify Dockerode type compatibility**

  Run the TypeScript compiler to confirm no type errors:

  ```bash
  cd /home/ae/multi-agent-harness/backend && npx tsc --noEmit 2>&1
  ```

  If `Tmpfs` is not in the Dockerode type definitions (older `@types/dockerode`), add a type cast:

  ```typescript
  // Type cast needed if @types/dockerode doesn't include Tmpfs
  ...(config.subAgentReadOnlyRootfs ? {
    ReadonlyRootfs: true,
    Tmpfs: {
      "/tmp": "rw,noexec,nosuid,size=100m",
      "/workspace": "rw,noexec,nosuid,size=2g",
    } as Record<string, string>,
  } : {}),
  ```

  The installed version is `@types/dockerode: ^3.3.23` — check if `Tmpfs` is present in the `HostConfig` interface:
  ```bash
  grep -n "Tmpfs" /home/ae/multi-agent-harness/backend/node_modules/@types/dockerode/index.d.ts | head -5
  ```

- [ ] **Step 4 — Add tests to `containerManager.test.ts`**

  Open `backend/src/__tests__/containerManager.test.ts`. Add the following tests inside the existing `describe("containerManager", ...)` block:

  ```typescript
  it("includes CapDrop ALL and SecurityOpt no-new-privileges in HostConfig", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-secure" });
    const mockDocker = { createContainer: mockCreate };
    await createSubAgentContainer(mockDocker as never, {
      sessionId: "sess-sec",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/proj-1/task-sec",
    });
    const hostConfig = mockCreate.mock.calls[0][0].HostConfig as {
      CapDrop: string[];
      SecurityOpt: string[];
    };
    expect(hostConfig.CapDrop).toEqual(["ALL"]);
    expect(hostConfig.SecurityOpt).toContain("no-new-privileges:true");
  });

  it("does not set ReadonlyRootfs when SUB_AGENT_READONLY_ROOTFS is not set", async () => {
    delete process.env.SUB_AGENT_READONLY_ROOTFS;
    // Re-import config to pick up env change (vitest module cache)
    vi.resetModules();
    const { createSubAgentContainer: createFresh } = await import("../orchestrator/containerManager.js");
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-rw" });
    await createFresh({ createContainer: mockCreate } as never, {
      sessionId: "sess-rw",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/task-rw",
    });
    const hostConfig = mockCreate.mock.calls[0][0].HostConfig;
    expect(hostConfig.ReadonlyRootfs).toBeUndefined();
    expect(hostConfig.Tmpfs).toBeUndefined();
  });

  it("sets ReadonlyRootfs and Tmpfs when SUB_AGENT_READONLY_ROOTFS=true", async () => {
    process.env.SUB_AGENT_READONLY_ROOTFS = "true";
    vi.resetModules();
    const { createSubAgentContainer: createFresh } = await import("../orchestrator/containerManager.js");
    const mockCreate = vi.fn().mockResolvedValue({ id: "container-ro" });
    await createFresh({ createContainer: mockCreate } as never, {
      sessionId: "sess-ro",
      repoCloneUrl: "https://github.com/org/repo.git",
      branchName: "agent/task-ro",
    });
    const hostConfig = mockCreate.mock.calls[0][0].HostConfig;
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.Tmpfs).toMatchObject({
      "/tmp": expect.stringContaining("rw"),
      "/workspace": expect.stringContaining("rw"),
    });
    delete process.env.SUB_AGENT_READONLY_ROOTFS;
  });
  ```

  Note: `vi.resetModules()` is needed because `config.ts` reads env vars at module load time. Each test that changes env vars must reset modules first.

- [ ] **Step 5 — Run tests**

  ```bash
  cd /home/ae/multi-agent-harness/backend && bun test src/__tests__/containerManager.test.ts --reporter=verbose 2>&1
  ```

  All existing tests must pass. The three new tests must pass.

- [ ] **Step 6 — Run full backend test suite**

  ```bash
  cd /home/ae/multi-agent-harness/backend && bun test --reporter=verbose 2>&1 | tail -30
  ```

- [ ] **Step 7 — Manual smoke test (requires running Docker)**

  Start the stack and trigger a task. Watch that the sub-agent container starts and runs successfully:

  ```bash
  docker inspect <container-id> --format '{{json .HostConfig.CapDrop}}'
  # Expected: ["ALL"]

  docker inspect <container-id> --format '{{json .HostConfig.SecurityOpt}}'
  # Expected: ["no-new-privileges:true"]
  ```

  Confirm that `git clone` and `git push` inside the container succeed (git needs no special capabilities under normal usage).

---

## Notes

### Capability analysis

- `CapDrop: ["ALL"]` removes the entire default capability set. The default Docker capability set includes `NET_BIND_SERVICE`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `NET_RAW`, and others. Removing these is standard hardening practice.
- Git operations (`git clone`, `git push`, `git commit`) do not require any Linux capabilities — they use standard file I/O and network sockets. The `CapDrop: ["ALL"]` change is safe for the sub-agent workload.
- If a future agent task needs `docker` CLI access inside the container (e.g., docker-in-docker), capabilities would need to be revisited. Document this in the sub-agent Dockerfile or README.

### ReadonlyRootfs considerations

- When `ReadonlyRootfs=true`, the container's root filesystem is immutable. The tmpfs mounts for `/tmp` (100 MB) and `/workspace` (2 GB) provide writable scratch space.
- The `noexec` flag on tmpfs mounts prevents execution of binaries written to those directories. This is a defense-in-depth measure — if an attacker writes a binary to `/tmp`, it cannot be executed.
- `/workspace` is where the sub-agent clones repos and runs builds. 2 GB should be sufficient for most repos; increase `size=2g` if builds fail with "No space left on device".
- `ReadonlyRootfs=false` (the default) leaves the existing behavior unchanged — useful for compatibility during rollout.

### no-new-privileges

- `SecurityOpt: ["no-new-privileges:true"]` prevents processes inside the container from gaining additional privileges via `setuid`/`setgid` binaries or file capabilities. This is a low-risk, high-value hardening option — it has no negative impact on normal agent workloads.
