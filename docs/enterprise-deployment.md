# Enterprise: Deployment Targets & Infrastructure

## Current State

Single deployment mode: Docker Compose on a developer's machine. Four images built from Debian/Ubuntu-based bases (`node:24-slim`, `oven/bun:1`, `nginx:alpine`). No Helm charts, no Kubernetes manifests, no registry configuration. Custom root CA certificates not handled. No proxy configuration in containers.

## Target State

Three deployment targets, two corporate base image options, corporate proxy and TLS support, with local Docker Compose retained as the default.

---

## 1. Deployment Targets

### Target A: GKE with Helm

Google Kubernetes Engine. Standard managed Kubernetes.

**Architecture:**
```
Namespace: multi-agent-harness
├── Deployment: backend (1-3 replicas behind Service)
├── Deployment: frontend (1-2 replicas behind Service)
├── Ingress (GKE Ingress or nginx-ingress)
├── Job/Pod: planning-agent-{projectId} (created dynamically)
├── Job/Pod: sub-agent-{taskId} (created dynamically)
├── PersistentVolumeClaim: harness-data (ReadWriteOnce → backend)
├── PersistentVolumeClaim: harness-pi-auth (ReadWriteMany → shared)
├── Secret: oidc-credentials
├── Secret: provider-api-keys
├── Secret: vcs-tokens
├── ConfigMap: harness-config
└── ServiceAccount: harness-agent-runner (RBAC for pod creation)
```

**Key change from Docker Compose:** The backend no longer talks to Docker. Instead, it uses the Kubernetes API (via `@kubernetes/client-node`) to create Jobs for planning agents and sub-agents. This requires:
- A `ContainerRuntime` abstraction layer (see section 4)
- A `ServiceAccount` with permissions to create/delete/watch Jobs and Pods in the namespace
- Pod templates defined in the Helm chart's `values.yaml`

**Helm chart structure:**
```
charts/multi-agent-harness/
├── Chart.yaml
├── values.yaml
├── values-gke.yaml
├── values-openshift.yaml
├── templates/
│   ├── backend-deployment.yaml
│   ├── backend-service.yaml
│   ├── frontend-deployment.yaml
│   ├── frontend-service.yaml
│   ├── ingress.yaml
│   ├── pvc.yaml
│   ├── configmap.yaml
│   ├── secrets.yaml
│   ├── serviceaccount.yaml
│   ├── rbac.yaml
│   ├── planning-agent-job.yaml    # Template, not deployed directly
│   └── sub-agent-job.yaml         # Template, not deployed directly
└── README.md
```

### Target B: OpenShift 4 with Helm

Same Helm chart with OpenShift-specific values overlay.

**OpenShift differences:**
- Routes instead of Ingress (or use `values-openshift.yaml` to switch)
- SecurityContextConstraints (SCC) — agents need `restricted-v2` SCC at minimum; if they need host filesystem, a custom SCC
- OpenShift runs containers as arbitrary UIDs — Dockerfiles must not assume specific UID (current `USER node` / `USER bun` needs adjustment to work with arbitrary UID assignment)
- Image pull from internal registry requires `imagePullSecrets` referencing Artifactory credentials
- OAuth proxy sidecar available for OIDC (alternative to application-level OIDC)

**values-openshift.yaml overrides:**
```yaml
ingress:
  enabled: false
route:
  enabled: true
  tls:
    termination: edge
securityContext:
  runAsNonRoot: true
  # Do NOT set runAsUser — OpenShift assigns arbitrary UID
```

### Target C: RHEL VM with Docker Compose

Closest to current setup. Docker Compose on a RHEL 8 VM with Podman or Docker CE.

**Changes from current:**
- `docker-compose.yml` updated to pull from Artifactory (image names prefixed with registry)
- `.env` or `docker-compose.override.yml` for corporate config (OIDC, proxy, certs)
- Systemd unit file for service management
- Log rotation via `journald` or Docker log driver → `json-file` with max-size

**Podman compatibility note:** Podman is the default on RHEL 8. The docker-socket-proxy pattern doesn't work with Podman.

**Recommended approach:** Use the Podman socket (`/run/podman/podman.sock`). Podman's REST API is Docker-compatible, so Dockerode connects without code changes. The tecnativa docker-socket-proxy is not needed — Podman's socket is already rootless. Configure via `DOCKER_HOST=unix:///run/podman/podman.sock` in the backend environment.

Alternative: Install Docker CE on RHEL 8 (requires RHEL subscription for `container-tools` module), which preserves the exact same setup as local development.

---

## 2. Base Images

### Current → Target Migration

| Image | Current Base | RHEL 8 Target | Wolfi Target |
|-------|-------------|---------------|--------------|
| backend | `node:24-slim` (Debian) | `registry.access.redhat.com/ubi8/nodejs-22` | `cgr.dev/chainguard/node:latest` |
| frontend | `nginx:alpine` → builder: `oven/bun:1` | UBI8 nginx: `registry.access.redhat.com/ubi8/nginx-124` | `cgr.dev/chainguard/nginx:latest` |
| planning-agent | `node:22-slim` (Debian) | `ubi8/nodejs-22` | `cgr.dev/chainguard/node:latest` |
| sub-agent | `oven/bun:1` (Debian) | `ubi8/nodejs-22` + bun installed (see note below) | `cgr.dev/chainguard/node:latest` + bun |

**Sub-agent bun compatibility note:** The sub-agent uses bun as its primary runtime (`runner.mjs` runs under bun). On UBI/Wolfi, bun must be installed as an additional binary (download from `bun.sh` releases). The runner is compatible with Node.js as well, but this configuration must be validated — the multi-stage Dockerfile should copy the bun binary and set it as the entrypoint.

**Approach:** Use build args in Dockerfiles to select base image at build time:

```dockerfile
ARG BASE_IMAGE=node:24-slim
FROM ${BASE_IMAGE} AS runtime
```

CI pipelines pass `--build-arg BASE_IMAGE=registry.access.redhat.com/ubi8/nodejs-22` for corporate builds.

### RHEL 8 (UBI) Considerations

- UBI images use `yum`/`dnf` instead of `apt-get` — Dockerfiles need conditional package installation or separate Dockerfiles per base
- UBI images don't include `gh` CLI — install from GitHub releases tarball or use API directly
- Node.js available as `ubi8/nodejs-22` with RHEL-patched OpenSSL
- JDK for sub-agent: `ubi8/openjdk-21` as builder stage, or install `java-21-openjdk-headless` via dnf
- **Recommendation:** Maintain separate `Dockerfile.ubi` per image rather than complex conditional logic in one Dockerfile

### Wolfi Considerations

- Chainguard Wolfi images are minimal, use `apk` package manager
- Significantly smaller attack surface (no shell in distroless variants)
- `cgr.dev` images require Chainguard subscription for fixed-tag versions
- Git, curl, JDK available as `wolfi-base` packages
- **Recommendation:** Same approach — `Dockerfile.wolfi` per image

### Dockerfile Strategy

```
backend/
  Dockerfile           # Default (Debian, local dev)
  Dockerfile.ubi       # RHEL 8 / UBI base
  Dockerfile.wolfi     # Wolfi / Chainguard base
```

CI passes `--file Dockerfile.ubi` or `--file Dockerfile.wolfi` based on build target. Docker Compose uses default `Dockerfile` for local.

---

## 3. Corporate TLS & Proxy

### Custom Root CA Certificates

Corporate networks use internal CAs for TLS inspection proxies. All containers must trust these CAs.

**Injection pattern:**

```dockerfile
# In every Dockerfile, after base image:
ARG CUSTOM_CA_BUNDLE=""
RUN if [ -n "$CUSTOM_CA_BUNDLE" ]; then \
      echo "$CUSTOM_CA_BUNDLE" >> /etc/ssl/certs/ca-certificates.crt; \
    fi
# For UBI: append to /etc/pki/tls/certs/ca-bundle.crt
# For Wolfi: append to /etc/ssl/certs/ca-certificates.crt
```

**Helm approach (better):** Mount a ConfigMap with the CA bundle into all pods:

```yaml
# values.yaml
customCACert: ""  # PEM-encoded CA bundle

# templates/backend-deployment.yaml
volumes:
  - name: custom-ca
    configMap:
      name: {{ .Release.Name }}-ca-bundle
volumeMounts:
  - name: custom-ca
    mountPath: /etc/ssl/certs/custom-ca.crt
    subPath: ca-bundle.crt
env:
  - name: NODE_EXTRA_CA_CERTS
    value: /etc/ssl/certs/custom-ca.crt
```

`NODE_EXTRA_CA_CERTS` makes Node.js trust the custom CA for all HTTPS requests (backend, planning agent, sub-agent).

For `git` operations in agent containers:
```
GIT_SSL_CAINFO=/etc/ssl/certs/custom-ca.crt
```

For `gh` CLI:
```
GH_CACERT=/etc/ssl/certs/custom-ca.crt
```

### HTTP(S) Proxy Configuration

Agent containers need proxy settings for internet-bound AI provider API calls.

**Environment variables:**
```
HTTP_PROXY=http://proxy.corp.example.com:8080
HTTPS_PROXY=http://proxy.corp.example.com:8080
NO_PROXY=backend,docker-proxy,localhost,127.0.0.1,.corp.example.com
```

**Propagation:**
- Backend: Set in Helm values / Docker Compose env
- Planning agent containers: Inherited from backend config, injected via `ContainerRuntime` at agent creation
- Sub-agent containers: Same — injected at container/pod creation
- `NO_PROXY` must include internal service names (`backend`, `docker-proxy`) to avoid routing internal traffic through the proxy

**Config addition to `config.ts`:**
```typescript
httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy,
httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
noProxy: process.env.NO_PROXY ?? process.env.no_proxy,
customCaCert: process.env.NODE_EXTRA_CA_CERTS,
```

These are forwarded to agent containers alongside existing `PROVIDER_ENV_VARS`.

---

## 4. Container Runtime Abstraction

The backend currently uses `Dockerode` directly via `backend/src/orchestrator/containerManager.ts`. To support Kubernetes, refactor this module into a `ContainerRuntime` interface with two implementations. The existing `containerManager.ts` functions become the `DockerContainerRuntime` implementation:

```typescript
interface ContainerRuntime {
  createAgent(opts: AgentContainerOpts): Promise<string>;  // returns ID
  startAgent(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  removeAgent(id: string): Promise<void>;
  getStatus(id: string): Promise<"running" | "exited" | "stopped" | "unknown">;
  watchExit(id: string, onExit: (code: number) => void): Promise<void>;
  streamLogs(id: string, label: string): Promise<void>;
}
```

**Implementations:**
- `DockerContainerRuntime` — wraps current Dockerode calls (for Docker Compose and RHEL VM)
- `KubernetesContainerRuntime` — creates Jobs/Pods via `@kubernetes/client-node` (for GKE/OpenShift)

**Selection:**
```typescript
const runtime = process.env.CONTAINER_RUNTIME === "kubernetes"
  ? new KubernetesContainerRuntime()
  : new DockerContainerRuntime(docker);
```

The planning agent's TCP RPC pattern works in Kubernetes — the backend connects to the Pod's IP on port 3333 (within the namespace network). **Service discovery**: The backend reads the Pod IP from the Kubernetes API after the Job's pod enters `Running` state. A headless Service is not needed — the planning agent pod is short-lived and 1:1 with the backend connection. The Pod IP approach is simpler and avoids managing Service lifecycle alongside Job lifecycle.

---

## 5. Persistent Storage

The `harness-pi-auth` volume stores OAuth tokens (e.g., GitHub Copilot) shared between the backend, planning agent pods, and sub-agent pods. All three mount it at `/pi-agent`. This requires ReadWriteMany in Kubernetes (multiple pods read/write concurrently).

| Deployment | SQLite DB | Pi-agent auth volume |
|------------|-----------|---------------------|
| Docker Compose | Named volume `harness-data` | Named volume `harness-pi-auth` |
| GKE | PVC (ReadWriteOnce, SSD) | PVC (ReadWriteMany via Filestore) |
| OpenShift | PVC (ReadWriteOnce) | PVC (ReadWriteMany via NFS/CephFS) |
| RHEL VM | Host path or named volume | Host path or named volume |

**Note:** SQLite with ReadWriteOnce means the backend cannot scale horizontally. This is acceptable for the initial enterprise deployment. PostgreSQL migration (see `enterprise-migration.md`) removes this constraint.

---

## 6. Networking

### Kubernetes

- Backend ↔ planning agent: Pod-to-Pod TCP on port 3333 (same namespace)
- Backend ↔ sub-agent: Pod-to-Pod HTTP for events/heartbeat
- Frontend → Backend: ClusterIP Service
- External → Frontend: Ingress (GKE) or Route (OpenShift)
- Agent → Internet: Egress through corporate proxy (NetworkPolicy allows proxy egress, denies direct internet)

**NetworkPolicy (recommended):**
```yaml
# Allow agent pods to talk to backend and corporate proxy only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-egress
spec:
  podSelector:
    matchLabels:
      harness.io/role: agent
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: backend
      ports:
        - port: 3000
    - to:
        - ipBlock:
            cidr: 10.0.1.50/32  # Corporate proxy IP — set via Helm values: networkPolicy.proxyIpCidr
      ports:
        - port: 8080
```

### Docker Compose (unchanged)

Current `harness-agents` bridge network works as-is. Add proxy env vars to agent containers.
