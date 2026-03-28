# Frontend CI Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Run tests` step to the `test-frontend` job in `.github/workflows/ci.yml` so frontend Vitest tests run in CI on every push and pull request.

**Architecture:** The frontend already has a working `"test": "vitest run"` script in `package.json` and a Vitest test suite. The CI job currently only type-checks and builds; adding a single YAML step before `Build` closes the gap. No new configuration is required because `vitest run` (not `vitest`) exits non-interactively with an appropriate exit code.

**Tech Stack:** GitHub Actions, Bun, Vitest (`vitest run`), React + Vite, TypeScript.

---

## Step 1 — Confirm the test script

- [ ] Read `frontend/package.json` and verify the `test` script is `vitest run`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

`vitest run` (as opposed to bare `vitest`) runs once and exits — it does not watch for file changes. This is the correct mode for CI. No changes needed to `package.json`.

## Step 2 — Run tests locally to confirm they pass

- [ ] Run from the repo root:

```bash
cd frontend && bun run test
```

All tests must exit with code 0 before touching the CI config. If any tests fail, fix them first (do not add a broken test step to CI).

Expected output resembles:

```
✓ src/components/ProjectList.test.tsx (3 tests)
✓ src/components/Chat.test.tsx (5 tests)
...
Test Files  X passed (X)
Tests       Y passed (Y)
```

## Step 3 — Edit `.github/workflows/ci.yml`

- [ ] Open `.github/workflows/ci.yml`
- [ ] Find the `test-frontend` job's `steps` section. The current steps are:

```yaml
      - name: Install dependencies
        run: bun install

      - name: Type check
        run: bunx tsc --noEmit

      - name: Build
        run: bun run build
```

- [ ] Insert the `Run tests` step between `Type check` and `Build`:

```yaml
      - name: Install dependencies
        run: bun install

      - name: Type check
        run: bunx tsc --noEmit

      - name: Run tests
        run: bun run test

      - name: Build
        run: bun run build
```

The full updated `test-frontend` job after the edit:

```yaml
  test-frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ./frontend

    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Type check
        run: bunx tsc --noEmit

      - name: Run tests
        run: bun run test

      - name: Build
        run: bun run build
```

Note: `--reporter=verbose` is optional. The default Vitest reporter is sufficient for CI — failures are clearly reported without it. Add it only if the team prefers verbose output:

```yaml
      - name: Run tests
        run: bun run test -- --reporter=verbose
```

(The extra `--` is required to pass flags through Bun's script runner to Vitest.)

## Step 4 — Verify the YAML is valid

- [ ] Confirm the file parses as valid YAML. If `yq` or `python3` is available:

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML valid"
```

## Step 5 — Commit and push

- [ ] Stage the single changed file:

```bash
git add .github/workflows/ci.yml
```

- [ ] Commit with a descriptive message:

```bash
git commit -m "ci: add vitest run step to frontend CI job"
```

- [ ] Push and observe the Actions run — the new `Run tests` step should appear in the `test-frontend` job and go green.

---

## Key files changed

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | Add `Run tests` step (`bun run test`) before `Build` in `test-frontend` job |

## Risks and notes

- `vitest run` is non-interactive and exits with code 1 on any test failure, which is correct for CI.
- The `working-directory: ./frontend` default applies to all steps, so `bun run test` correctly resolves to `frontend/package.json`'s `test` script without any path changes.
- If Vitest requires a DOM environment (jsdom), check `frontend/vite.config.ts` or `vitest.config.ts` for `environment: "jsdom"`. The project already has `jsdom` in devDependencies, so this should be configured correctly.
- There is no need to add a separate `--run` flag because `vitest run` is already the non-watch mode; `vitest` (without `run`) is the watch mode.
