# Alternative Dockerfiles (UBI 8 and Wolfi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create UBI 8 and Wolfi/Chainguard Dockerfile variants for all four images (backend, frontend, planning-agent, sub-agent) to support enterprise environments that require RHEL-compatible or minimal-CVE base images.

**Architecture:** Each service gets two additional Dockerfiles alongside its existing Debian-based one: `Dockerfile.ubi` (Red Hat UBI 8) and `Dockerfile.wolfi` (Chainguard Wolfi). The UBI variants use `registry.access.redhat.com/ubi8/*` base images and install bun from the official installer script. The Wolfi variants use `cgr.dev/chainguard/node` and install additional tooling via `apk`. A new CI matrix job builds all variants to catch regressions without replacing the default build. The existing `Dockerfile` files are untouched.

**Tech Stack:** Red Hat UBI 8 (`ubi8/nodejs-22`, `ubi8/openjdk-21`, `ubi8/nginx-124`), Chainguard Wolfi (`cgr.dev/chainguard/node`), bun installer script, Docker BuildKit multi-stage builds, GitHub Actions matrix strategy.

---

## File Map

Files to create (existing Dockerfiles are NOT modified):

- `backend/Dockerfile.ubi` — UBI 8 backend image
- `backend/Dockerfile.wolfi` — Wolfi backend image
- `frontend/Dockerfile.ubi` — UBI 8 frontend image (builder + nginx-124 server)
- `frontend/Dockerfile.wolfi` — Wolfi frontend image (builder + nginx server)
- `planning-agent/Dockerfile.ubi` — UBI 8 planning-agent image
- `planning-agent/Dockerfile.wolfi` — Wolfi planning-agent image
- `sub-agent/Dockerfile.ubi` — UBI 8 sub-agent image (most complex: JDK + Maven + bun + gh CLI)
- `sub-agent/Dockerfile.wolfi` — Wolfi sub-agent image

Files to modify:

- `.github/workflows/ci.yml` — add build-matrix job for all alt Dockerfiles

---

## Context: What the base images need

**backend:** Node.js 24 runtime + bun (package manager + build tool) + python3/make/g++ (for better-sqlite3 native build via node-gyp). Final image: node to run `dist/index.js`.

**frontend:** bun (build tool only) in builder stage; nginx in server stage. No runtime Node.js needed.

**planning-agent:** Node.js 22 runtime + git + gh CLI. Uses `npm install` and runs via `node runner.mjs`.

**sub-agent:** bun runtime (runs `runner.mjs`) + git + default-jdk (Java 21) + Maven + gh CLI + Node.js 24 (for some tools in runner). Most tooling-heavy image.

---

## Task 1 — backend/Dockerfile.ubi

**Files:**
- Create: `backend/Dockerfile.ubi`

- [ ] **Step 1: Create backend/Dockerfile.ubi**

The UBI nodejs-22 image is based on RHEL 8. It includes node but not bun. We install bun via the official script, then use it to install packages and build, but run the final app with `node` (UBI nodejs-22 has node in the final stage too).

Create `backend/Dockerfile.ubi`:

```dockerfile
# backend/Dockerfile.ubi
# Red Hat UBI 8 variant — uses ubi8/nodejs-22 for RHEL compatibility.
# Build context: backend/

FROM registry.access.redhat.com/ubi8/nodejs-22 AS builder

# Switch to root for installs
USER root

WORKDIR /app

# Install build tools needed by node-gyp (for better-sqlite3)
RUN dnf install -y python3 make gcc-c++ && dnf clean all

# Install bun (used for lockfile-aware installs and TypeScript build)
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    bun --version

# Copy package manifest and lockfile
COPY package.json bun.lock ./

# Install deps — skip lifecycle scripts; rebuild better-sqlite3 explicitly below
RUN bun install --ignore-scripts

# Rebuild better-sqlite3 native binding for the current Node.js ABI
COPY scripts ./scripts
RUN bash scripts/rebuild-sqlite3.sh

# Copy source and compile TypeScript
COPY . .
RUN bun run build

# ---- Runtime stage ----
FROM registry.access.redhat.com/ubi8/nodejs-22

USER root
WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /app/data /pi-agent && \
    chown -R 1001:0 /app /pi-agent && \
    chmod -R g=u /app /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

# UBI runs as UID 1001 by default (matches OpenShift arbitrary UID range)
USER 1001

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Verify the Dockerfile builds (build context is `backend/`)**

```bash
docker build -f backend/Dockerfile.ubi backend/ -t multi-agent-harness/backend:ubi-test
```

Expected: Build completes, no errors. The `better-sqlite3` rebuild step should print `Done.`

- [ ] **Step 3: Smoke-test the image starts**

```bash
docker run --rm -e PORT=3000 -e DATA_DIR=/app/data \
  multi-agent-harness/backend:ubi-test node dist/index.js &
sleep 3
curl -sf http://localhost:3000/api/health && echo "OK"
docker stop $(docker ps -q --filter ancestor=multi-agent-harness/backend:ubi-test)
```

Expected: `OK` printed.

---

## Task 2 — backend/Dockerfile.wolfi

**Files:**
- Create: `backend/Dockerfile.wolfi`

- [ ] **Step 1: Create backend/Dockerfile.wolfi**

Chainguard's `cgr.dev/chainguard/node` is based on Wolfi (musl libc). It uses `apk` for packages. We install bun + build tools, then build.

Create `backend/Dockerfile.wolfi`:

```dockerfile
# backend/Dockerfile.wolfi
# Chainguard Wolfi variant — minimal CVE surface.
# Build context: backend/

FROM cgr.dev/chainguard/node:latest AS builder

USER root
WORKDIR /app

# Install bun and build tools for better-sqlite3 (node-gyp requires python3 + make + g++)
RUN apk add --no-cache curl python3 make g++ && \
    curl -fsSL https://bun.sh/install | sh && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    bun --version

COPY package.json bun.lock ./
RUN bun install --ignore-scripts

COPY scripts ./scripts
RUN bash scripts/rebuild-sqlite3.sh

COPY . .
RUN bun run build

# ---- Runtime stage ----
FROM cgr.dev/chainguard/node:latest

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /app/data /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

# Chainguard images run as nonroot (UID 65532) by default
USER nonroot

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Build and smoke-test**

```bash
docker build -f backend/Dockerfile.wolfi backend/ -t multi-agent-harness/backend:wolfi-test
docker run --rm -e PORT=3000 -e DATA_DIR=/app/data \
  multi-agent-harness/backend:wolfi-test node dist/index.js &
sleep 3
curl -sf http://localhost:3000/api/health && echo "OK"
docker stop $(docker ps -q --filter ancestor=multi-agent-harness/backend:wolfi-test)
```

---

## Task 3 — frontend/Dockerfile.ubi

**Files:**
- Create: `frontend/Dockerfile.ubi`

- [ ] **Step 1: Create frontend/Dockerfile.ubi**

The frontend uses bun only in the build stage. UBI provides `ubi8/nginx-124` for the server stage. Note: the `nginx.conf` already exists at `frontend/nginx.conf` — we reuse it unchanged.

Create `frontend/Dockerfile.ubi`:

```dockerfile
# frontend/Dockerfile.ubi
# Red Hat UBI 8 variant — nginx-124 server image.
# Build context: frontend/

FROM registry.access.redhat.com/ubi8/nodejs-22 AS builder

USER root
WORKDIR /app

# Install bun for frontend build
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN bun run build

# ---- Runtime stage ----
FROM registry.access.redhat.com/ubi8/nginx-124

# Copy built static assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Replace default nginx config with our SPA + proxy config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

# UBI nginx-124 runs as UID 1001 by default (non-root)
CMD ["nginx", "-g", "daemon off;"]
```

Note: UBI nginx-124 listens on port 8080 by default (not 80) to avoid needing root. If your nginx.conf has `listen 80`, add a sed replacement step or create a separate `nginx.conf.ubi` that uses port 8080.

- [ ] **Step 2: Adjust nginx port for UBI (UBI nginx runs as non-root on 8080)**

The existing `nginx.conf` uses `listen 80`. UBI nginx-124 runs as UID 1001 which cannot bind port 80. Add a sed step in the Dockerfile:

Edit `frontend/Dockerfile.ubi` — replace the nginx stage with:

```dockerfile
# ---- Runtime stage ----
FROM registry.access.redhat.com/ubi8/nginx-124

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# UBI nginx-124 runs as non-root; rewrite listen port from 80 -> 8080
RUN sed -i 's/listen 80;/listen 8080;/' /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 3: Build and verify**

```bash
docker build -f frontend/Dockerfile.ubi frontend/ -t multi-agent-harness/frontend:ubi-test
docker run --rm -p 18080:8080 multi-agent-harness/frontend:ubi-test &
sleep 2
curl -sf http://localhost:18080/ | grep -q "<html" && echo "Frontend OK"
docker stop $(docker ps -q --filter ancestor=multi-agent-harness/frontend:ubi-test)
```

---

## Task 4 — frontend/Dockerfile.wolfi

**Files:**
- Create: `frontend/Dockerfile.wolfi`

- [ ] **Step 1: Create frontend/Dockerfile.wolfi**

Chainguard provides `cgr.dev/chainguard/nginx` as a minimal nginx image.

Create `frontend/Dockerfile.wolfi`:

```dockerfile
# frontend/Dockerfile.wolfi
# Chainguard Wolfi variant — minimal nginx server.
# Build context: frontend/

FROM cgr.dev/chainguard/node:latest AS builder

USER root
WORKDIR /app

RUN apk add --no-cache curl && \
    curl -fsSL https://bun.sh/install | sh && \
    mv /root/.bun/bin/bun /usr/local/bin/bun

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN bun run build

# ---- Runtime stage ----
FROM cgr.dev/chainguard/nginx:latest

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
```

- [ ] **Step 2: Build and verify**

```bash
docker build -f frontend/Dockerfile.wolfi frontend/ -t multi-agent-harness/frontend:wolfi-test
docker run --rm -p 18081:8080 multi-agent-harness/frontend:wolfi-test &
sleep 2
curl -sf http://localhost:18081/ | grep -q "<html" && echo "Frontend OK"
docker stop $(docker ps -q --filter ancestor=multi-agent-harness/frontend:wolfi-test)
```

---

## Task 5 — planning-agent/Dockerfile.ubi

**Files:**
- Create: `planning-agent/Dockerfile.ubi`

- [ ] **Step 1: Create planning-agent/Dockerfile.ubi**

The planning-agent uses `npm install` (no bun runtime needed — it runs via `node runner.mjs`). It needs git + gh CLI. Build context is repo root (same as the existing planning-agent Dockerfile).

Create `planning-agent/Dockerfile.ubi`:

```dockerfile
# planning-agent/Dockerfile.ubi
# Red Hat UBI 8 variant.
# Build context: repo root (for shared/ directory access)

FROM registry.access.redhat.com/ubi8/nodejs-22

USER root

# Install git (already present in ubi8/nodejs-22) and curl
RUN dnf install -y git curl && dnf clean all

# Install gh CLI from GitHub releases tarball (not in UBI repos)
RUN GH_VERSION=2.45.0 && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local && \
    gh --version

WORKDIR /app

COPY planning-agent/package.json .
RUN npm install

RUN mkdir -p /workspace /pi-agent && chown 1001:0 /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=1001:0 planning-agent/runner.mjs .
COPY --chown=1001:0 planning-agent/tools.mjs .
COPY --chown=1001:0 planning-agent/system-prompt.md .

COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch"
RUN mkdir -p /home/node/.config/rtk
COPY shared/config/rtk-config.toml /home/node/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/

USER 1001

ENTRYPOINT ["node", "/app/runner.mjs"]
```

- [ ] **Step 2: Build (build context is repo root)**

```bash
docker build -f planning-agent/Dockerfile.ubi . -t multi-agent-harness/planning-agent:ubi-test
```

Expected: Build completes. `gh --version` output visible in build log.

---

## Task 6 — planning-agent/Dockerfile.wolfi

**Files:**
- Create: `planning-agent/Dockerfile.wolfi`

- [ ] **Step 1: Create planning-agent/Dockerfile.wolfi**

Create `planning-agent/Dockerfile.wolfi`:

```dockerfile
# planning-agent/Dockerfile.wolfi
# Chainguard Wolfi variant.
# Build context: repo root

FROM cgr.dev/chainguard/node:latest

USER root

# Install git, curl, and gh CLI
RUN apk add --no-cache git curl

# Install gh CLI from GitHub releases
RUN GH_VERSION=2.45.0 && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local && \
    gh --version

WORKDIR /app

COPY planning-agent/package.json .
RUN npm install

RUN mkdir -p /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY planning-agent/runner.mjs .
COPY planning-agent/tools.mjs .
COPY planning-agent/system-prompt.md .

COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch"
RUN mkdir -p /home/node/.config/rtk
COPY shared/config/rtk-config.toml /home/node/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/

USER nonroot

ENTRYPOINT ["node", "/app/runner.mjs"]
```

- [ ] **Step 2: Build**

```bash
docker build -f planning-agent/Dockerfile.wolfi . -t multi-agent-harness/planning-agent:wolfi-test
```

---

## Task 7 — sub-agent/Dockerfile.ubi

**Files:**
- Create: `sub-agent/Dockerfile.ubi`

- [ ] **Step 1: Create sub-agent/Dockerfile.ubi**

The sub-agent needs: bun (runtime for `runner.mjs`), git, JDK 21, Maven, gh CLI, Node.js 24 (some harness tooling). Use `ubi8/openjdk-21` as base (includes JDK). Install bun, Maven, gh CLI, and Node.js on top.

Create `sub-agent/Dockerfile.ubi`:

```dockerfile
# sub-agent/Dockerfile.ubi
# Red Hat UBI 8 variant — includes OpenJDK 21, Maven, bun, gh CLI.
# Build context: repo root

FROM registry.access.redhat.com/ubi8/openjdk-21

USER root

# Install build tools + Node.js 24 repo
RUN dnf install -y curl git && \
    curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && \
    dnf install -y nodejs && \
    dnf clean all

# Install Maven
RUN dnf install -y maven && dnf clean all

# Install bun
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    bun --version

# Install gh CLI from GitHub releases (not in UBI repos)
RUN GH_VERSION=2.45.0 && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local && \
    gh --version

WORKDIR /app

COPY sub-agent/package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent && chown 1001:0 /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY --chown=1001:0 sub-agent/runner.mjs .
COPY --chown=1001:0 sub-agent/tools.mjs .

COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch"
RUN mkdir -p /home/jboss/.config/rtk
COPY shared/config/rtk-config.toml /home/jboss/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/

# ubi8/openjdk-21 default user is jboss (UID 185) — use a fixed non-root UID
USER 1001

ENTRYPOINT ["bun", "/app/runner.mjs"]
```

- [ ] **Step 2: Build (build context is repo root)**

```bash
docker build -f sub-agent/Dockerfile.ubi . -t multi-agent-harness/sub-agent:ubi-test
```

Expected: Build succeeds. The bun, java, mvn, and gh version lines should appear.

- [ ] **Step 3: Verify tools are present in the image**

```bash
docker run --rm multi-agent-harness/sub-agent:ubi-test \
  sh -c "bun --version && java --version && mvn --version && gh --version"
```

Expected: All four tools print their version numbers.

---

## Task 8 — sub-agent/Dockerfile.wolfi

**Files:**
- Create: `sub-agent/Dockerfile.wolfi`

- [ ] **Step 1: Create sub-agent/Dockerfile.wolfi**

Chainguard's apk registry provides openjdk-21 and maven packages.

Create `sub-agent/Dockerfile.wolfi`:

```dockerfile
# sub-agent/Dockerfile.wolfi
# Chainguard Wolfi variant — minimal CVE surface.
# Build context: repo root

FROM cgr.dev/chainguard/node:latest

USER root

# Install all tooling via apk
RUN apk add --no-cache \
    git \
    curl \
    openjdk-21 \
    maven \
    nodejs-24

# Install bun
RUN curl -fsSL https://bun.sh/install | sh && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    bun --version

# Install gh CLI
RUN GH_VERSION=2.45.0 && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local && \
    gh --version

WORKDIR /app

COPY sub-agent/package.json .
RUN bun install

RUN mkdir -p /workspace /pi-agent

ENV PI_CODING_AGENT_DIR=/pi-agent

COPY sub-agent/runner.mjs .
COPY sub-agent/tools.mjs .

COPY shared/bin/rtk /usr/local/bin/rtk
RUN chmod +x /usr/local/bin/rtk && \
    /usr/local/bin/rtk --version || echo "[warn] rtk not runnable on this arch"
RUN mkdir -p /home/nonroot/.config/rtk
COPY shared/config/rtk-config.toml /home/nonroot/.config/rtk/config.toml
COPY shared/extensions/ /app/shared/extensions/

USER nonroot

ENTRYPOINT ["bun", "/app/runner.mjs"]
```

- [ ] **Step 2: Build and verify tools**

```bash
docker build -f sub-agent/Dockerfile.wolfi . -t multi-agent-harness/sub-agent:wolfi-test
docker run --rm multi-agent-harness/sub-agent:wolfi-test \
  sh -c "bun --version && java --version && mvn --version && gh --version"
```

---

## Task 9 — Add build matrix job to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

This task adds a new `build-alt-dockerfiles` job to the existing CI workflow. The job builds all 8 alt Dockerfiles in a matrix without running tests — it just verifies they compile. The existing `test-backend` and `test-frontend` jobs are untouched.

- [ ] **Step 1: Read current ci.yml to find the end of the file**

Open `.github/workflows/ci.yml` and identify the last line of the `test-frontend` job (currently line 53).

- [ ] **Step 2: Append the matrix job to ci.yml**

Append the following to `.github/workflows/ci.yml` after the existing `test-frontend` job:

```yaml

  build-alt-dockerfiles:
    name: Build alt Dockerfiles (${{ matrix.service }}-${{ matrix.variant }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - service: backend
            variant: ubi
            context: ./backend
            dockerfile: backend/Dockerfile.ubi
          - service: backend
            variant: wolfi
            context: ./backend
            dockerfile: backend/Dockerfile.wolfi
          - service: frontend
            variant: ubi
            context: ./frontend
            dockerfile: frontend/Dockerfile.ubi
          - service: frontend
            variant: wolfi
            context: ./frontend
            dockerfile: frontend/Dockerfile.wolfi
          - service: planning-agent
            variant: ubi
            context: .
            dockerfile: planning-agent/Dockerfile.ubi
          - service: planning-agent
            variant: wolfi
            context: .
            dockerfile: planning-agent/Dockerfile.wolfi
          - service: sub-agent
            variant: ubi
            context: .
            dockerfile: sub-agent/Dockerfile.ubi
          - service: sub-agent
            variant: wolfi
            context: .
            dockerfile: sub-agent/Dockerfile.wolfi

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build ${{ matrix.service }} (${{ matrix.variant }})
        uses: docker/build-push-action@v5
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          push: false
          load: false
          cache-from: type=gha,scope=${{ matrix.service }}-${{ matrix.variant }}
          cache-to: type=gha,scope=${{ matrix.service }}-${{ matrix.variant }},mode=max
```

- [ ] **Step 3: Verify the workflow file is valid YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 4: Commit all alt Dockerfiles and CI update**

```bash
git add backend/Dockerfile.ubi backend/Dockerfile.wolfi \
        frontend/Dockerfile.ubi frontend/Dockerfile.wolfi \
        planning-agent/Dockerfile.ubi planning-agent/Dockerfile.wolfi \
        sub-agent/Dockerfile.ubi sub-agent/Dockerfile.wolfi \
        .github/workflows/ci.yml
git commit -m "feat: add UBI 8 and Wolfi Dockerfile variants for all services (Phase 4)"
```
