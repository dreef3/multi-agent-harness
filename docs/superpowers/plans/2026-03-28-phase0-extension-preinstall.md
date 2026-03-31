# Extension Pre-install in Docker Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate or minimise the runtime cost of `DefaultResourceLoader.reload()` by pre-running extension initialization during `docker build`, baking any resulting cache files into the image layer.

**Architecture:** This plan has two concrete paths depending on whether the `@mariozechner/pi-coding-agent` SDK writes extension state to a discoverable cache directory during `DefaultResourceLoader.reload()`. Step 1 runs an investigation to determine which path applies. Path A (SDK writes to a cacheable directory) implements the pre-init and captures the cache. Path B (SDK does not expose a cacheable directory or reload is already fast) documents the finding and pins the SDK version for reproducibility.

**Tech Stack:** Docker multi-stage-aware `RUN` layer caching, Bun runtime, `@mariozechner/pi-coding-agent` SDK, `sub-agent/Dockerfile`, `planning-agent/Dockerfile`.

---

## Step 1 — Investigate SDK cache behaviour (REQUIRED before any implementation)

This step determines which path to take. Do not skip it.

### Step 1a — Measure current `DefaultResourceLoader.reload()` duration

- [ ] Run a throwaway sub-agent container and capture the time from container start to `[sub-agent] Running task:` log line. This measures the total overhead including `resourceLoader.reload()`. Example measurement approach:

```bash
# Start a no-op task and time the startup phase
time docker run --rm \
  -e REPO_CLONE_URL=https://github.com/example/dummy \
  -e BRANCH_NAME=main \
  -e TASK_DESCRIPTION="echo done" \
  multi-agent-harness/sub-agent:latest 2>&1 | head -20
```

Record the elapsed time. If the time between container start and the `[sub-agent] Running task:` line is under 2 seconds, this optimisation has minimal impact and Path B applies.

### Step 1b — Identify SDK cache directory

- [ ] In a running sub-agent container (or a one-shot `docker run --rm`), run the resource loader and then list all new files created:

```bash
docker run --rm multi-agent-harness/sub-agent:latest bun -e "
  const { DefaultResourceLoader, SettingsManager } = await import('@mariozechner/pi-coding-agent');
  const sm = SettingsManager.inMemory();
  const rl = new DefaultResourceLoader({
    settingsManager: sm,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  const before = Date.now();
  await rl.reload();
  const elapsed = Date.now() - before;
  console.log('reload() elapsed ms:', elapsed);
" 2>&1
```

Then check whether any files were written by examining likely cache directories:

```bash
docker run --rm multi-agent-harness/sub-agent:latest bun -e "
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { DefaultResourceLoader, SettingsManager } = await import('@mariozechner/pi-coding-agent');
  const sm = SettingsManager.inMemory();
  const rl = new DefaultResourceLoader({
    settingsManager: sm,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await rl.reload();
  // Check common cache locations
  const candidates = [
    '/root/.cache',
    '/home/bun/.cache',
    '/root/.pi-agent-cache',
    '/home/bun/.pi-agent-cache',
    '/tmp/.pi-agent-cache',
    '/app/.pi-agent-cache',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      console.log('EXISTS:', dir);
      try {
        const listing = fs.readdirSync(dir, { recursive: true });
        listing.slice(0, 20).forEach(f => console.log('  ', f));
      } catch {}
    }
  }
" 2>&1
```

### Step 1c — Interpret results

| Result | Path |
|---|---|
| `reload()` elapsed < 500 ms | Path B — already fast, optimisation unnecessary |
| `reload()` elapsed >= 500 ms AND cache directory found with written files | Path A — implement pre-init with cache capture |
| `reload()` elapsed >= 500 ms AND no cache directory found | Path B — SDK doesn't persist state; document and pin version |

---

## Path A — SDK writes to a cache directory

Follow these steps **only if Step 1 confirms a cache directory with written files**.

### Step A1 — Identify exact cache directory path

- [ ] From the output of Step 1b, record the exact cache directory (e.g. `/home/bun/.cache/pi-agent`). This is `<CACHE_DIR>` in the steps below.

### Step A2 — Update `sub-agent/Dockerfile` to pre-initialize resource loader

- [ ] Read `sub-agent/Dockerfile` (already read — reference lines 20–43).

The current `WORKDIR /app` section:
```dockerfile
WORKDIR /app

# Install pi-coding-agent as a local dependency so runner.mjs can import it
COPY sub-agent/package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent
```

- [ ] Add the pre-initialization block immediately after `RUN bun install`:

```dockerfile
# Pre-initialize resource loader — extension loading baked into image layer
# This eliminates the extension download/setup at container startup.
# The USER directive below switches to bun; the pre-init must match the runtime user.
# Run as root here and fix ownership afterward.
COPY sub-agent/runner.mjs .
COPY sub-agent/tools.mjs .
COPY shared/extensions/ /app/shared/extensions/
RUN bun -e "
  const { DefaultResourceLoader, SettingsManager } = await import('@mariozechner/pi-coding-agent');
  const sm = SettingsManager.inMemory();
  const rl = new DefaultResourceLoader({
    settingsManager: sm,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await rl.reload();
  console.log('[build] Resource loader pre-initialized successfully');
" 2>&1 || echo "[warn] Resource loader pre-init failed — will initialize at runtime"
```

**Important note on the `USER bun` directive:** The Dockerfile currently sets `USER bun` near the end (line 41). The pre-init `RUN` step runs as root (the default). If the SDK writes its cache to a path under `/home/bun/`, the cache will be owned by root and unreadable by `bun` at runtime. Handle this with an ownership fix:

```dockerfile
# Fix ownership of SDK cache if it was written during build (runs as root)
RUN if [ -d "<CACHE_DIR>" ]; then chown -R bun:bun <CACHE_DIR>; fi
```

Replace `<CACHE_DIR>` with the actual path discovered in Step A1.

Alternatively, run the pre-init as the `bun` user:

```dockerfile
USER bun
RUN bun -e "..." 2>&1 || echo "[warn] ..."
USER root
```

Use whichever approach fits the Dockerfile structure.

### Step A3 — Update `planning-agent/Dockerfile` similarly

- [ ] Read `planning-agent/Dockerfile`.
- [ ] Apply the same pre-initialization pattern, adapted for the planning agent's resource loader options:

```dockerfile
RUN bun -e "
  const { DefaultResourceLoader, SettingsManager } = await import('@mariozechner/pi-coding-agent');
  const sm = SettingsManager.inMemory();
  const rl = new DefaultResourceLoader({
    settingsManager: sm,
    noPromptTemplates: true,
    noThemes: true,
    // Note: planning agent does NOT pass noSkills: true
  });
  await rl.reload();
  console.log('[build] Planning agent resource loader pre-initialized');
" 2>&1 || echo "[warn] Resource loader pre-init failed — will initialize at runtime"
```

### Step A4 — Verify build succeeds and pre-init runs

- [ ] Build the sub-agent image and confirm the pre-init log line appears:

```bash
docker compose build sub-agent 2>&1 | grep -E "(pre-initialized|warn.*Resource loader)"
```

Expected output: `[build] Resource loader pre-initialized successfully`

### Step A5 — Measure improvement

- [ ] Repeat the timing test from Step 1a with the new image.
- [ ] Record the new elapsed time in a comment in the Dockerfile:

```dockerfile
# Pre-init reduces reload() from ~Xms to ~Yms (measured YYYY-MM-DD)
```

### Step A6 — Add `|| true` safety net (resilience)

The pre-init `|| echo "[warn]..."` in Steps A2/A3 already makes the build non-fatal on failure. Confirm that the container still starts and works correctly even if the pre-init didn't produce a usable cache (i.e. `reload()` runs at full cost at runtime). This is the existing behaviour so no code change is needed — just verify manually by temporarily running the pre-init with a deliberate error:

```dockerfile
RUN bun -e "throw new Error('forced fail')" || echo "[warn] Resource loader pre-init failed — will initialize at runtime"
```

Build and run a test task to confirm the agent still works.

---

## Path B — SDK does not expose a cacheable directory

Follow these steps **only if Step 1 finds no cache directory OR reload() is already fast**.

### Step B1 — Document the finding

- [ ] Add a comment block to `sub-agent/Dockerfile` immediately after `RUN bun install`:

```dockerfile
# NOTE (2026-03-28): Extension pre-initialization was investigated.
# DefaultResourceLoader.reload() completed in <Xms> — no persistent cache directory
# was written by the SDK. Pre-initialization baked into the Docker image layer is
# therefore not feasible without SDK changes. The current startup cost is acceptable.
# Re-evaluate when upgrading @mariozechner/pi-coding-agent.
```

- [ ] Add the same comment to `planning-agent/Dockerfile`.

### Step B2 — Pin SDK version for reproducibility

- [ ] Read `sub-agent/package.json` to check the current `@mariozechner/pi-coding-agent` version specifier.
- [ ] If the version specifier uses a range (e.g. `^1.2.3` or `>=1.0.0`), pin it to the exact version currently installed:

```bash
# Find current installed version
docker run --rm multi-agent-harness/sub-agent:latest \
  cat /app/node_modules/@mariozechner/pi-coding-agent/package.json | grep '"version"'
```

- [ ] Update `sub-agent/package.json` to use the exact version (e.g. `"1.2.3"` instead of `"^1.2.3"`).
- [ ] Repeat for `planning-agent/package.json`.
- [ ] Run `bun install` in each directory to update `bun.lock` with the pinned version.
- [ ] Commit the updated `package.json` and lock files with message: `chore: pin pi-coding-agent version (pre-init investigation)`

### Step B3 — Track as future work

- [ ] If the investigation reveals that `reload()` is slow but produces no cacheable files, open a tracking note in the plan:

  **Future work:** Contact `@mariozechner/pi-coding-agent` maintainers about exposing a `CACHE_DIR` option in `DefaultResourceLoader` so pre-built Docker images can skip network-dependent initialization at container startup.

---

## Step 2 — Run full test suite after changes

Regardless of which path was taken:

- [ ] `cd backend && bun run test` — confirm no backend tests broken.
- [ ] `cd sub-agent && bun test` — confirm tools tests pass.
- [ ] Build both images: `docker compose build sub-agent planning-agent`.
- [ ] Confirm containers start and the first log line `[sub-agent] Running task:` appears within an acceptable time.

---

## Summary of files changed

**Path A:**

| File | Change |
|---|---|
| `sub-agent/Dockerfile` | Add pre-init RUN block + ownership fix |
| `planning-agent/Dockerfile` | Add pre-init RUN block + ownership fix |

**Path B:**

| File | Change |
|---|---|
| `sub-agent/Dockerfile` | Add explanatory comment |
| `planning-agent/Dockerfile` | Add explanatory comment |
| `sub-agent/package.json` | Pin `@mariozechner/pi-coding-agent` to exact version |
| `planning-agent/package.json` | Pin `@mariozechner/pi-coding-agent` to exact version |
| `sub-agent/bun.lock` | Updated lock file |
| `planning-agent/bun.lock` / root `bun.lock` | Updated lock file |
