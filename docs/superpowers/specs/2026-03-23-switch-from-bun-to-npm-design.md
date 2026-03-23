# Bun to Node.js/NPM Migration — Design Spec

## Context & Motivation

Bun causes issues with AI agents (unexpected behavior), CI reliability problems, and Docker image build failures. This project currently uses Bun as the primary runtime, and this spec outlines the migration to pure Node.js/NPM across all components.

## Scope

**Goal:** Replace Bun with Node.js 24 LTS and npm everywhere in the multi-agent-harness project.

**Components affected:**
- Root workspace scripts
- Backend (with native module `better-sqlite3`)
- Frontend (Vite build)
- Sub-agent Docker image
- E2E tests (Playwright)
- CI/CD workflows

**Not affected:**
- Planning agent (already uses Node.js/npm)

---

## Files to Modify

### Root Workspace

| File | Action | Changes |
|------|--------|---------|
| `package.json` | Modify | Replace `bun run` with `npm run` |
| `bun.lock` | Delete | Binary lockfile, replaced by npm |
| `package-lock.json` | Create | Generated via `npm install` |

### Backend

| File | Action | Changes |
|------|--------|---------|
| `backend/package.json` | Modify | Scripts: `bun --watch` → `tsx --watch`, `bun dist/index.js` → `node dist/index.js`, `bun install` → `npm install` |
| `backend/Dockerfile` | Modify | Replace `oven/bun:1` with `node:24-slim`, use `npm install` and `npm run build` |
| `backend/scripts/rebuild-sqlite3.sh` | Modify | Update to use npm/node paths for better-sqlite3 |

### Frontend

| File | Action | Changes |
|------|--------|---------|
| `frontend/package.json` | Modify | Replace `bunx vite` with `npx vite` or `npm run` |
| `frontend/Dockerfile` | Modify | Replace `oven/bun:1 AS builder` with `node:24-slim AS builder`, `bun install` → `npm install`, `bun run build` → `npm run build` |

### Sub-agent

| File | Action | Changes |
|------|--------|---------|
| `sub-agent/Dockerfile` | Modify | Replace `oven/bun:1` base with `node:24-slim`, `bun install` → `npm install`, `bun /app/runner.mjs` → `node /app/runner.mjs` |

### E2E Tests

| File | Action | Changes |
|------|--------|---------|
| `e2e-tests/package.json` | Modify | Replace `bunx playwright` with `npx playwright` |

### CI/CD

| File | Action | Changes |
|------|--------|---------|
| `.github/workflows/ci.yml` | Modify | Replace `oven-sh/setup-bun@v2` with `actions/setup-node@v4` (node-version: '24'), `bun install` → `npm ci`, `bunx` → `npx` |
| `.github/workflows/e2e.yml` | Modify | Same Node.js setup change |

---

## Script Mappings

| Bun Script | NPM Equivalent |
|------------|----------------|
| `bun run --cwd backend dev` | `npm run --workspace=backend dev` |
| `bun run --cwd frontend dev` | `npm run --workspace=frontend dev` |
| `bun run --cwd backend build` | `npm run --workspace=backend build` |
| `bun run --cwd e2e-tests test` | `npm run --workspace=e2e-tests test` |
| `bun --watch src/index.ts` | `tsx --watch src/index.ts` |
| `bun dist/index.js` | `node dist/index.js` |
| `bun install` | `npm install` |
| `bunx vite` | `npx vite` |
| `bunx playwright test` | `npx playwright test` |
| `bunx tsc --noEmit` | `npx tsc --noEmit` |

---

## Docker Image Changes

### Backend Dockerfile

**Before:**
```dockerfile
FROM oven/bun:1 AS bun-binary

FROM node:24-slim AS builder
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 make g++ && rm -rf /var/lib/apt/lists/* \
    && npm install -g node-gyp

COPY package.json bun.lock ./
RUN bun install --ignore-scripts
COPY scripts ./scripts
RUN bash scripts/rebuild-sqlite3.sh
COPY . .
RUN bun run build
```

**After:**
```dockerfile
FROM node:24-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 make g++ && rm -rf /var/lib/apt/lists/* \
    && npm install -g node-gyp

COPY package.json ./
RUN npm install --ignore-scripts
COPY scripts ./scripts
RUN bash scripts/rebuild-sqlite3.sh
COPY . .
RUN npm run build
```

### Frontend Dockerfile

**Before:**
```dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .
RUN bun run build
```

**After:**
```dockerfile
FROM node:24-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
```

### Sub-agent Dockerfile

**Before:**
```dockerfile
FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git default-jdk maven build-essential python3 curl \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN bun install
RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent
ENV PI_CODING_AGENT_DIR=/pi-agent
COPY --chown=bun:bun runner.mjs .
USER bun
ENTRYPOINT ["bun", "/app/runner.mjs"]
```

**After:**
```dockerfile
FROM node:24-slim

RUN apt-get update && apt-get install -y \
    git default-jdk maven build-essential python3 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
RUN mkdir -p /workspace /pi-agent && chown node:node /workspace /pi-agent
ENV PI_CODING_AGENT_DIR=/pi-agent
COPY --chown=node:node runner.mjs .
USER node
ENTRYPOINT ["node", "/app/runner.mjs"]
```

Note: Node 24 is already available in the `node:24-slim` base image, so the nodesource setup script is no longer needed.

---

## CI Workflow Changes

### ci.yml

**Before:**
```yaml
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
```

**After:**
```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '24'

- name: Install dependencies
  run: npm ci

- name: Type check
  run: npx tsc --noEmit

- name: Run tests
  run: npm run test
```

---

## Rebuild Script Changes

The `backend/scripts/rebuild-sqlite3.sh` script needs to be updated to handle npm's module structure:

**Before:**
```bash
SQLITE_DIR=$(ls -d node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1)
if [ -z "$SQLITE_DIR" ] && [ -d "node_modules/better-sqlite3" ]; then
  SQLITE_DIR="node_modules/better-sqlite3"
fi
```

**After:**
```bash
SQLITE_DIR="node_modules/better-sqlite3"
```

The npm structure places `better-sqlite3` directly in `node_modules/`, so the bun-specific path lookup is no longer needed.

---

## Implementation Order

1. **Backend** (most complex - native modules)
   - Update `backend/package.json` scripts
   - Update `backend/Dockerfile`
   - Update `backend/scripts/rebuild-sqlite3.sh`
   - Test: `npm install && npm run build && npm test`

2. **Frontend**
   - Update `frontend/package.json` scripts
   - Update `frontend/Dockerfile`
   - Test: `npm install && npm run build`

3. **Sub-agent**
   - Update `sub-agent/Dockerfile`
   - Test: Docker build

4. **Root workspace**
   - Delete `bun.lock`
   - Update root `package.json` scripts
   - Generate `package-lock.json`
   - Test: `npm run build`, `npm run test`

5. **E2E tests**
   - Update `e2e-tests/package.json` scripts
   - Test: `npm install && npx playwright test`

6. **CI/CD**
   - Update `.github/workflows/ci.yml`
   - Update `.github/workflows/e2e.yml`

---

## Verification Checklist

After migration, verify:

- [ ] `bun.lock` deleted from root
- [ ] `package-lock.json` generated in root and each workspace
- [ ] `npm install` succeeds in each workspace
- [ ] `npm run build` succeeds in backend, frontend
- [ ] `npm run test` succeeds in backend
- [ ] Docker builds succeed for backend, frontend, sub-agent
- [ ] CI workflows pass (or Docker builds pass if CI unavailable)

---

## Rollback Plan

If issues arise, rollback is straightforward:
1. Restore `bun.lock` from git
2. Restore original package.json scripts
3. Restore original Dockerfiles
4. Restore original CI workflow files

No data migration or complex state changes are involved.
