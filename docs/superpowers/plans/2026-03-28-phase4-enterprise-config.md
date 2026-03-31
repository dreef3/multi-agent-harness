# Enterprise Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add corporate proxy support, custom CA cert injection, Artifactory npm registry configuration, a `docker-compose.corp.yaml` overlay for enterprise deployments, and a systemd service unit for RHEL VM deployments.

**Architecture:** Corporate CA certs and proxy settings are propagated in two layers: (1) baked into images at build time via a `CUSTOM_CA_BUNDLE` build-arg, and (2) forwarded at runtime from the backend process environment into spawned sub-agent containers via `containerManager.ts`. The `docker-compose.corp.yaml` file is a pure override that replaces image refs with corporate Artifactory coordinates, adds PostgreSQL, and wires all proxy/auth env vars — deployed with `docker compose -f docker-compose.yml -f docker-compose.corp.yaml up`. A `bunfig.corp.toml` file configures bun/npm to use the corporate Artifactory registry.

**Tech Stack:** Docker Compose v2 file merging, Docker `--build-arg`, Node.js `NODE_EXTRA_CA_CERTS`, bun `bunfig.toml`, systemd oneshot service, RHEL 8+/UBI, PostgreSQL 16.

---

## File Map

Files to create:

- `docker-compose.corp.yaml` — Docker Compose enterprise overlay
- `bunfig.corp.toml` — bun/npm Artifactory registry config
- `deploy/harness.service` — systemd unit for RHEL VM deployment

Files to modify:

- `backend/Dockerfile` — add `CUSTOM_CA_BUNDLE` build-arg + trust-store injection
- `frontend/Dockerfile` — add `CUSTOM_CA_BUNDLE` build-arg to builder stage
- `planning-agent/Dockerfile` — add `CUSTOM_CA_BUNDLE` build-arg
- `sub-agent/Dockerfile` — add `CUSTOM_CA_BUNDLE` build-arg
- `backend/src/orchestrator/containerManager.ts` — forward proxy + CA env vars to agent containers

---

## Task 1 — Add CUSTOM_CA_BUNDLE build-arg to backend/Dockerfile

**Files:**
- Modify: `backend/Dockerfile`

The `CUSTOM_CA_BUNDLE` build-arg accepts a PEM certificate bundle. When non-empty, the bundle is appended to the system trust store in both the builder and runtime stages.

- [ ] **Step 1: Read the current backend/Dockerfile**

Open `backend/Dockerfile` and locate the `FROM node:24-slim AS builder` line (currently line 3) and the `FROM node:24-slim` runtime stage (line 25).

- [ ] **Step 2: Add build-arg and CA injection to the builder stage**

In `backend/Dockerfile`, after `FROM node:24-slim AS builder` (line 3) and before `WORKDIR /app`, add:

```dockerfile
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
```

- [ ] **Step 3: Add build-arg and CA injection to the runtime stage**

In `backend/Dockerfile`, after `FROM node:24-slim` (runtime stage, currently line 25) and before `WORKDIR /app`, add:

```dockerfile
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
```

- [ ] **Step 4: Verify the Dockerfile still builds without the build-arg (default empty)**

```bash
docker build -f backend/Dockerfile backend/ -t multi-agent-harness/backend:ca-test
```

Expected: Build succeeds. The `if` guard prevents any CA steps from running when `CUSTOM_CA_BUNDLE` is empty.

- [ ] **Step 5: Verify the build-arg works with a test CA**

```bash
# Generate a self-signed test CA (do not use in production)
openssl req -x509 -newkey rsa:2048 -keyout /tmp/test-ca.key \
  -out /tmp/test-ca.pem -days 1 -nodes \
  -subj "/CN=TestCA"

docker build -f backend/Dockerfile backend/ \
  --build-arg CUSTOM_CA_BUNDLE="$(cat /tmp/test-ca.pem)" \
  -t multi-agent-harness/backend:ca-test

# Verify the cert is in the runtime image's trust store
docker run --rm multi-agent-harness/backend:ca-test \
  grep -c "TestCA" /etc/ssl/certs/ca-certificates.crt
```

Expected: Output is `1` (the test CA appears in the bundle).

- [ ] **Step 6: Commit backend Dockerfile change**

```bash
git add backend/Dockerfile
git commit -m "feat(backend): add CUSTOM_CA_BUNDLE build-arg for corporate CA injection"
```

---

## Task 2 — Add CUSTOM_CA_BUNDLE build-arg to frontend, planning-agent, sub-agent Dockerfiles

**Files:**
- Modify: `frontend/Dockerfile`
- Modify: `planning-agent/Dockerfile`
- Modify: `sub-agent/Dockerfile`

- [ ] **Step 1: Add to frontend/Dockerfile (builder stage only — nginx stage has no npm/node to worry about)**

In `frontend/Dockerfile`, after `FROM oven/bun:1 AS builder` and before `WORKDIR /app`, add:

```dockerfile
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
```

- [ ] **Step 2: Add to planning-agent/Dockerfile**

In `planning-agent/Dockerfile`, after `FROM node:22-slim` and before the `RUN apt-get update` block, add:

```dockerfile
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
```

- [ ] **Step 3: Add to sub-agent/Dockerfile**

In `sub-agent/Dockerfile`, after `FROM oven/bun:1` and before the `RUN apt-get update` block, add:

```dockerfile
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      printf "%s\n" "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt && \
      update-ca-certificates 2>/dev/null || true; \
    fi
```

- [ ] **Step 4: Build all three Dockerfiles to verify no regressions**

```bash
docker build -f frontend/Dockerfile frontend/ -t multi-agent-harness/frontend:ca-test
docker build -f planning-agent/Dockerfile . -t multi-agent-harness/planning-agent:ca-test
docker build -f sub-agent/Dockerfile . -t multi-agent-harness/sub-agent:ca-test
```

Expected: All three complete without errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/Dockerfile planning-agent/Dockerfile sub-agent/Dockerfile
git commit -m "feat: add CUSTOM_CA_BUNDLE build-arg to frontend, planning-agent, sub-agent Dockerfiles"
```

---

## Task 3 — Forward proxy and CA env vars into agent containers

**Files:**
- Modify: `backend/src/orchestrator/containerManager.ts`

The backend process may receive `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` from its own environment (set in `docker-compose.corp.yaml`). These must be forwarded to sub-agent containers so they can reach external services (GitHub, Anthropic API) through the corporate proxy.

- [ ] **Step 1: Read the current createSubAgentContainer function**

Open `backend/src/orchestrator/containerManager.ts`. The `providerEnv` array (lines 52-55) and `taskEnv` array (lines 60-68) are combined into the container `Env` field on line 89.

- [ ] **Step 2: Add proxy env forwarding**

In `containerManager.ts`, after the `const providerEnv = ...` block (line 55), add:

```typescript
// Forward corporate proxy env vars if present in the backend process environment
const PROXY_ENV_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
];
const proxyEnvVars = PROXY_ENV_VARS
  .filter(name => process.env[name])
  .map(name => `${name}=${process.env[name]}`);

// Forward custom CA cert path for Node.js certificate verification
const caEnvVars: string[] = [];
if (process.env.NODE_EXTRA_CA_CERTS) {
  caEnvVars.push(`NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}`);
}
if (process.env.GIT_SSL_CAINFO) {
  caEnvVars.push(`GIT_SSL_CAINFO=${process.env.GIT_SSL_CAINFO}`);
}
```

- [ ] **Step 3: Add proxyEnvVars and caEnvVars to container Env**

In `containerManager.ts`, find the `Env:` array inside `docker.createContainer()` (currently line 89):

```typescript
Env: [`REPO_CLONE_URL=${opts.repoCloneUrl}`, `BRANCH_NAME=${opts.branchName}`, ...taskEnv, ...providerEnv],
```

Replace with:

```typescript
Env: [
  `REPO_CLONE_URL=${opts.repoCloneUrl}`,
  `BRANCH_NAME=${opts.branchName}`,
  ...taskEnv,
  ...providerEnv,
  ...proxyEnvVars,
  ...caEnvVars,
],
```

- [ ] **Step 4: Add log line so proxy forwarding is visible in debug output**

After the existing log lines (around line 79), add:

```typescript
if (proxyEnvVars.length > 0) {
  console.log(`[containerManager]   proxyEnvVars forwarded: [${proxyEnvVars.map(e => e.split("=")[0]).join(", ")}]`);
}
```

- [ ] **Step 5: Run backend type check**

```bash
cd backend && bunx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Run backend tests**

```bash
cd backend && bun run test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/orchestrator/containerManager.ts
git commit -m "feat(containerManager): forward proxy and CA env vars into sub-agent containers"
```

---

## Task 4 — Create docker-compose.corp.yaml

**Files:**
- Create: `docker-compose.corp.yaml`

- [ ] **Step 1: Create docker-compose.corp.yaml**

Create `docker-compose.corp.yaml`:

```yaml
# Corporate overlay — deploy with:
#   docker compose -f docker-compose.yml -f docker-compose.corp.yaml up -d
#
# Required env vars (set in .env or shell):
#   CORP_REGISTRY     — e.g. corp-artifactory.example.com/docker-local
#   IMAGE_TAG         — e.g. 1.2.3 or latest
#   OIDC_ISSUER_URL   — e.g. https://sso.corp.example.com/realms/engineering
#   OIDC_CLIENT_ID    — registered OIDC client id
#   POSTGRES_PASSWORD — strong random password
#
# Optional:
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY — corporate HTTP proxy
#   CUSTOM_CA_BUNDLE                    — PEM bundle of extra CA certs

services:
  backend:
    image: ${CORP_REGISTRY:-corp-artifactory.example.com/docker-local}/multi-agent-harness/backend:${IMAGE_TAG:-latest}
    environment:
      AUTH_ENABLED: "true"
      OIDC_ISSUER_URL: ${OIDC_ISSUER_URL:?OIDC_ISSUER_URL is required in corp deployment}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?OIDC_CLIENT_ID is required in corp deployment}
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1,postgres}
      http_proxy: ${HTTP_PROXY:-}
      https_proxy: ${HTTPS_PROXY:-}
      no_proxy: ${NO_PROXY:-localhost,127.0.0.1,postgres}
      # NODE_EXTRA_CA_CERTS is forwarded to sub-agent containers by containerManager.ts
      NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS:-}
      DATABASE_TYPE: postgresql
      DATABASE_URL: postgresql://harness:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/harness
    depends_on:
      postgres:
        condition: service_healthy

  frontend:
    image: ${CORP_REGISTRY:-corp-artifactory.example.com/docker-local}/multi-agent-harness/frontend:${IMAGE_TAG:-latest}

  planning-agent:
    image: ${CORP_REGISTRY:-corp-artifactory.example.com/docker-local}/multi-agent-harness/planning-agent:${IMAGE_TAG:-latest}
    environment:
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1}
      http_proxy: ${HTTP_PROXY:-}
      https_proxy: ${HTTPS_PROXY:-}
      no_proxy: ${NO_PROXY:-localhost,127.0.0.1}

  sub-agent:
    image: ${CORP_REGISTRY:-corp-artifactory.example.com/docker-local}/multi-agent-harness/sub-agent:${IMAGE_TAG:-latest}
    environment:
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1}
      http_proxy: ${HTTP_PROXY:-}
      https_proxy: ${HTTPS_PROXY:-}
      no_proxy: ${NO_PROXY:-localhost,127.0.0.1}

  postgres:
    image: ${CORP_REGISTRY:-corp-artifactory.example.com/docker-local}/postgres:16
    environment:
      POSTGRES_DB: harness
      POSTGRES_USER: harness
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes:
      - harness-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harness"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  harness-postgres:
```

- [ ] **Step 2: Verify the overlay parses correctly (requires docker compose v2)**

```bash
docker compose -f docker-compose.yml -f docker-compose.corp.yaml \
  --env-file /dev/null config 2>&1 | head -20
```

Expected: Either a merged YAML config dump (may show errors for missing required vars like `POSTGRES_PASSWORD`, which is correct — that's `:?` in action) or a clean YAML output if env vars are set.

- [ ] **Step 3: Verify required vars trigger errors**

```bash
# This should fail with a clear error about POSTGRES_PASSWORD
CORP_REGISTRY=test IMAGE_TAG=test OIDC_ISSUER_URL=https://sso OIDC_CLIENT_ID=harness \
  docker compose -f docker-compose.yml -f docker-compose.corp.yaml config 2>&1 | grep -i "required"
```

Expected: Output contains `POSTGRES_PASSWORD is required`.

---

## Task 5 — Create bunfig.corp.toml

**Files:**
- Create: `bunfig.corp.toml`

This file configures bun's package installer to use the corporate Artifactory npm registry. It is not used by default — engineers activate it by setting `BUNFIG_TOML` or copying it over `bunfig.toml`.

- [ ] **Step 1: Create bunfig.corp.toml**

Create `bunfig.corp.toml`:

```toml
# Corporate Artifactory npm registry configuration.
#
# Usage (CI):
#   cp bunfig.corp.toml bunfig.toml
#   ARTIFACTORY_NPM_TOKEN=<token> bun install
#
# Usage (Docker build):
#   COPY bunfig.corp.toml bunfig.toml
#   (add to Dockerfile before RUN bun install)

[install]
# Route all npm installs through Artifactory npm-remote virtual repo.
# This repo proxies the public registry and caches packages locally.
registry = "https://corp-artifactory.example.com/api/npm/npm-remote/"

[install.scopes]
# Private packages in the corp npm-local repo require a token.
# The token is read from the env var at bun install time.
"@mariozechner" = { token = "$ARTIFACTORY_NPM_TOKEN", url = "https://corp-artifactory.example.com/api/npm/npm-local/" }
```

Note: The `@mariozechner` scope covers `@mariozechner/pi-coding-agent` which is a private backend dependency. Adjust the scope to match your organisation's internal package namespace.

- [ ] **Step 2: Verify the TOML syntax is valid**

```bash
python3 -c "
import sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib
with open('bunfig.corp.toml', 'rb') as f:
    data = tomllib.load(f)
print('TOML valid:', list(data.keys()))
"
```

Expected: `TOML valid: ['install']`

If `tomllib` is not available (Python < 3.11), install tomli: `pip install tomli`

---

## Task 6 — Create deploy/harness.service (systemd unit for RHEL VM)

**Files:**
- Create: `deploy/harness.service`

- [ ] **Step 1: Create the deploy/ directory and service unit**

```bash
mkdir -p deploy
```

Create `deploy/harness.service`:

```ini
[Unit]
Description=Multi-Agent Harness
Documentation=https://github.com/dreef3/multi-agent-harness
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes

# Working directory must contain docker-compose.yml, docker-compose.corp.yaml, and .env
WorkingDirectory=/opt/multi-agent-harness

# Use corporate overlay — remove second -f if not using corporate config
ExecStart=/usr/bin/docker compose \
  -f docker-compose.yml \
  -f docker-compose.corp.yaml \
  up -d --pull=missing

ExecStop=/usr/bin/docker compose \
  -f docker-compose.yml \
  -f docker-compose.corp.yaml \
  down

# Restart policy: do not restart automatically — use systemctl start manually
Restart=no

TimeoutStartSec=120
TimeoutStopSec=60

# Log to systemd journal (view with: journalctl -u harness)
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create deploy/install.sh — helper script for first-time RHEL setup**

Create `deploy/install.sh`:

```bash
#!/usr/bin/env bash
# First-time installation script for RHEL 8+ VM deployment.
# Run as root.
set -euo pipefail

INSTALL_DIR=/opt/multi-agent-harness

echo "==> Creating install directory"
mkdir -p "$INSTALL_DIR"

echo "==> Copying compose files"
cp docker-compose.yml "$INSTALL_DIR/"
cp docker-compose.corp.yaml "$INSTALL_DIR/"

echo "==> Copying .env (edit $INSTALL_DIR/.env after installation)"
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp .env.example "$INSTALL_DIR/.env"
  echo "    IMPORTANT: Edit $INSTALL_DIR/.env before starting the service"
fi

echo "==> Installing systemd unit"
cp deploy/harness.service /etc/systemd/system/harness.service

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling harness service (start on boot)"
systemctl enable harness

echo ""
echo "Installation complete."
echo "Edit $INSTALL_DIR/.env, then run: systemctl start harness"
echo "View logs with: journalctl -u harness -f"
```

```bash
chmod +x deploy/install.sh
```

- [ ] **Step 3: Verify the service unit syntax (if systemd is available)**

```bash
# Only works on a system with systemd — skip on macOS/containers
systemd-analyze verify deploy/harness.service 2>&1 || echo "systemd-analyze not available (non-RHEL host)"
```

Expected: Either `0 errors` or the "not available" fallback message.

- [ ] **Step 4: Commit all enterprise config files**

```bash
git add docker-compose.corp.yaml bunfig.corp.toml deploy/
git commit -m "feat: add corporate proxy, CA bundle, Artifactory config, compose overlay, systemd unit (Phase 4)"
```

---

## Task 7 — Integration test: full enterprise startup smoke test

This task verifies the complete corporate deployment config works end-to-end on a local machine with proxy vars set (even if the proxy doesn't exist, we verify the vars reach containers).

- [ ] **Step 1: Create a .env.corp.test for testing**

Create a temporary `/tmp/.env.corp.test`:

```bash
cat > /tmp/.env.corp.test << 'EOF'
CORP_REGISTRY=ghcr.io/dreef3/multi-agent-harness
IMAGE_TAG=latest
OIDC_ISSUER_URL=https://sso.example.com/realms/test
OIDC_CLIENT_ID=harness-test
POSTGRES_PASSWORD=test_password_not_prod
HTTP_PROXY=http://proxy.example.com:3128
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,postgres
GITHUB_TOKEN=ghp_placeholder
ANTHROPIC_API_KEY=sk-ant-placeholder
EOF
```

- [ ] **Step 2: Validate the merged compose config**

```bash
docker compose -f docker-compose.yml -f docker-compose.corp.yaml \
  --env-file /tmp/.env.corp.test config > /tmp/corp-config-rendered.yaml
echo "Merged config saved to /tmp/corp-config-rendered.yaml"
grep "HTTP_PROXY" /tmp/corp-config-rendered.yaml
```

Expected: `HTTP_PROXY: http://proxy.example.com:3128` appears in the backend service environment.

- [ ] **Step 3: Verify AUTH_ENABLED is true in backend service**

```bash
grep "AUTH_ENABLED" /tmp/corp-config-rendered.yaml
```

Expected: `AUTH_ENABLED: 'true'`

- [ ] **Step 4: Clean up**

```bash
rm /tmp/.env.corp.test /tmp/corp-config-rendered.yaml
```
