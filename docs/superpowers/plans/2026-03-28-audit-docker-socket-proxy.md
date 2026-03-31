# Docker Socket Proxy Permission Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the `tecnativa/docker-socket-proxy` to the minimum permissions the harness backend actually requires, removing the over-broad `NETWORKS: 1` permission and adding the missing `EVENTS: 1` permission needed by `watchContainerExit`.

**Architecture:** A single change to `docker-compose.yml` in the `docker-proxy` service's `environment` block. The backend never creates or inspects Docker networks — the `harness-agents` network is created by `docker compose up` and referenced only by name. Docker events are used by `watchContainerExit` and are blocked by default without explicit `EVENTS: 1`.

**Tech Stack:** Docker Compose, `tecnativa/docker-socket-proxy:0.1.2`.

---

## Context

**File:** `/home/ae/multi-agent-harness/docker-compose.yml` lines 24–33

Current proxy config:
```yaml
docker-proxy:
  image: tecnativa/docker-socket-proxy:0.1.2
  environment:
    CONTAINERS: 1
    IMAGES: 1
    NETWORKS: 1
    POST: 1
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
```

### Permission audit

The `tecnativa/docker-socket-proxy` routes HTTP requests to the Docker socket and blocks by default. Each `PERMISSION: 1` env var allows GET (and optionally POST/DELETE) access to that Docker API resource group.

| Permission | Docker API paths | Backend uses? | Keep? |
|---|---|---|---|
| `CONTAINERS` | `/containers/*` | Yes — create, start, stop, remove, inspect | Yes |
| `POST` | Allows POST verbs for permitted resources | Yes — `createContainer` is POST | Yes |
| `IMAGES` | `/images/*` | Yes — `ensureSubAgentImage` inspects the image | Yes |
| `NETWORKS` | `/networks/*` | **No** — networks are created by compose, not backend code | **Remove** |
| `EVENTS` | `/events` | **Yes** — `watchContainerExit` calls `docker.getEvents()` | **Add** |
| `INFO` | `/info` | Not currently used, but harmless | Not needed |

### How `tecnativa/docker-socket-proxy` handles `/events`

The proxy routes `/events` under the `EVENTS` environment variable. Without `EVENTS: 1`, GET requests to `/events` return HTTP 403. The `docker.getEvents()` call in Dockerode issues `GET /events?filters=...`, which will be blocked without this permission.

**This is a pre-existing bug**: `watchContainerExit` was introduced but the proxy was never updated to allow `EVENTS`. The proxy currently blocks the events stream, causing `watchContainerExit` to fail silently (the promise resolves but no `data` events ever fire). This means the polling fallback has been doing all the work.

---

## Steps

- [ ] **Step 1 — Update `docker-compose.yml`**

  In `/home/ae/multi-agent-harness/docker-compose.yml`, replace the `docker-proxy` service environment block:

  **Current (lines 28–32):**
  ```yaml
      environment:
        CONTAINERS: 1
        IMAGES: 1
        NETWORKS: 1
        POST: 1
  ```

  **Replacement:**
  ```yaml
      environment:
        CONTAINERS: 1
        IMAGES: 1
        POST: 1
        EVENTS: 1        # required for docker.getEvents() used by watchContainerExit
        # NETWORKS intentionally omitted — harness-agents network is managed by compose,
        # not by the backend. Re-enable if the backend ever creates networks dynamically.
  ```

  Also verify the docker socket volume mount — it currently has no `:ro` suffix. The proxy image documentation recommends mounting read-only since the proxy controls write access, not the mount:

  **Current:**
  ```yaml
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
  ```

  **Updated (add `:ro` to the socket mount):**
  ```yaml
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock:ro
  ```

  The proxy itself writes to the socket on behalf of the backend, but the proxy container only needs read access to the socket file to listen; the actual writes go through the socket protocol. Adding `:ro` is a defense-in-depth measure.

  Full updated `docker-proxy` service block:
  ```yaml
    docker-proxy:
      image: tecnativa/docker-socket-proxy:0.1.2
      environment:
        CONTAINERS: 1
        IMAGES: 1
        POST: 1
        EVENTS: 1        # required for docker.getEvents() used by watchContainerExit
        # NETWORKS intentionally omitted — harness-agents network is managed by compose,
        # not by the backend. Re-enable if the backend ever creates networks dynamically.
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock:ro
  ```

- [ ] **Step 2 — Recreate the proxy container**

  ```bash
  cd /home/ae/multi-agent-harness
  docker compose up -d --force-recreate docker-proxy
  ```

  The proxy container must be recreated (not just restarted) for env var changes to take effect.

- [ ] **Step 3 — Verify EVENTS permission allows `/events` GET**

  From inside the backend container or from the host (if docker-proxy port is exposed):

  ```bash
  # If docker-proxy exposes port 2375 on host for testing:
  curl -s "http://localhost:2375/events?filters=%7B%22event%22%3A%5B%22die%22%5D%7D&until=$(date -d '+2 seconds' +%s)" 2>&1
  # Should return an empty JSON stream or block for 2 seconds, NOT return 403
  ```

  Alternatively, check proxy logs for authorization decisions:
  ```bash
  docker compose logs docker-proxy 2>&1 | tail -20
  ```

  After the fix, `docker.getEvents()` calls should pass through (HTTP 200), not be blocked (HTTP 403).

- [ ] **Step 4 — Verify NETWORKS is blocked**

  From a container on the same network as the proxy:

  ```bash
  docker compose exec backend wget -qO- http://docker-proxy:2375/networks 2>&1
  # Expected: 403 Forbidden (or connection refused on some proxy versions)
  # Not expected: JSON list of networks
  ```

  This confirms the NETWORKS restriction is in effect.

- [ ] **Step 5 — Integration smoke test**

  Start the full stack and trigger a task dispatch. Monitor backend logs:

  ```bash
  docker compose up -d
  docker compose logs -f backend 2>&1 | grep -E "(watchContainerExit|getEvents|Container.*exited)"
  ```

  After a sub-agent container exits, you should see:
  ```
  [taskDispatcher] Container <id> exited with code 0
  ```

  This confirms the Docker events stream is now working through the proxy.

- [ ] **Step 6 — Update `docker-compose.override.yml` or `.env.example` if applicable**

  Check for any override files:
  ```bash
  ls /home/ae/multi-agent-harness/docker-compose*.yml
  ```

  If a `docker-compose.override.yml` exists and overrides the proxy environment, update it to include `EVENTS: 1` and remove `NETWORKS: 1` there as well.

---

## Notes

### Why `EVENTS: 1` was missing

The `watchContainerExit` function was likely added after the initial `docker-compose.yml` was written. The initial proxy config only covered `CONTAINERS`, `IMAGES`, `NETWORKS`, and `POST` — the baseline needed to create and manage containers. The events API was added later without updating the proxy.

### Why removing `NETWORKS: 1` is safe

The backend code (`containerManager.ts`) never calls any Docker networks API. Searching the codebase:
- `docker.createNetwork` — not called anywhere in backend/src
- `docker.listNetworks` — not called anywhere in backend/src
- `docker.getNetwork` — not called anywhere in backend/src

The `NetworkMode` property set in `HostConfig` during container creation is a string field in the container spec, not a separate Docker networks API call. The proxy only needs `CONTAINERS: 1` and `POST: 1` for this to work.

### Socket `:ro` mount caveat

On some Linux systems and Docker Desktop versions, the Docker socket requires write permission even when accessed through the proxy (because the proxy writes to it on behalf of clients). If adding `:ro` to the socket mount causes the proxy to fail to start, remove `:ro`. The proxy image documentation for `0.1.2` does recommend `:ro` for the socket mount, but test it with your Docker setup.

### Future NETWORKS re-enablement

If a future feature requires the backend to create per-task networks (e.g., for namespace isolation in a Kubernetes migration), re-enable `NETWORKS: 1` in the proxy config. Add a comment in the compose file explaining why it was re-enabled.

### tecnativa/docker-socket-proxy permission reference

The full list of supported environment variables for `docker-socket-proxy:0.1.2` maps to Docker API resource groups:
- `AUTH`, `BUILD`, `COMMIT`, `CONFIGS`, `CONTAINERS`, `DISTRIBUTION`, `EVENTS`, `EXEC`, `GRPC`, `IMAGES`, `INFO`, `NETWORKS`, `NODES`, `PLUGINS`, `POST`, `SECRETS`, `SERVICES`, `SESSION`, `SWARM`, `SYSTEM`, `TASKS`, `VERSION`, `VOLUMES`

All default to `0` (blocked) except `INFO` and `VERSION` which default to `1`.
