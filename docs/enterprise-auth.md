# Enterprise: Authentication, Authorization & Multi-Tenancy

## Current State

The harness has **zero authentication**. All API endpoints and WebSocket connections are open. There is no concept of users, roles, or permissions. Any network-adjacent client can create projects, trigger agents, and read all data.

This is acceptable for single-developer local use but blocks any shared or corporate deployment.

## Target State

Shared workspace visible to all squads (Tech Lead, Business Analysts, QA, Developers across 3 squads). OIDC-based authentication for corporate deployments. No auth required for local mode. Role-based access control governs who can perform which actions.

---

## 1. Authentication

### OIDC Integration

Client-side Authorization Code Grant with PKCE. The frontend drives the OIDC flow, stores tokens in `localStorage`, and sends the access token (JWT) as a `Bearer` token on every request. The backend is stateless — it validates the JWT signature and claims on each request, with no server-side session store.

**Flow:**
```
1. Browser → Frontend detects no token → redirects to IdP authorize endpoint
   (with code_challenge, client_id, redirect_uri, scope=openid profile email)
2. User authenticates at IdP
3. IdP redirects back to frontend callback route with authorization code
4. Frontend exchanges code for tokens (id_token + access_token + refresh_token)
   via IdP token endpoint (PKCE — no client secret needed for public client)
5. Frontend stores tokens in localStorage
6. All API requests: Authorization: Bearer <access_token>
7. WebSocket: token passed as query param on connection
8. Frontend uses refresh_token to renew access_token before expiry
```

**Implementation approach:**

| Component | Change |
|-----------|--------|
| Backend | Add `jose` library for JWT verification. Middleware fetches OIDC JWKS from issuer's `/.well-known/openid-configuration` at startup (cached, refreshed on key rotation). Validates `iss`, `aud`, `exp`, `nbf` on every request. Extracts user identity and roles from token claims. **No session store, no cookies, no passport.** |
| Frontend | Add OIDC client library (`oidc-client-ts` or similar). `AuthProvider` React context manages auth code flow, token storage, silent refresh, and logout. Attaches `Authorization: Bearer` header to all API calls via fetch wrapper. |
| WebSocket | Token passed as `?token=<access_token>` query parameter on upgrade. Backend validates JWT before accepting the connection. Token refresh: frontend disconnects and reconnects with new token before expiry. |
| nginx | No auth-related config needed. Pass `Authorization` header through to backend (default behavior). |

**Configuration (env vars):**
```
AUTH_ENABLED=true|false          # Master switch (false for local mode)
OIDC_ISSUER_URL=https://idp.corp.example.com/realms/harness
OIDC_CLIENT_ID=multi-agent-harness
OIDC_AUDIENCE=multi-agent-harness  # Expected 'aud' claim in JWT (often same as client_id)
```

**Note:** No `OIDC_CLIENT_SECRET` — the frontend is a public OIDC client using PKCE (Proof Key for Code Exchange). This is the recommended approach for SPAs per OAuth 2.0 for Browser-Based Apps (RFC draft). No server-side session secret or session store is required.

**JWT Verification details:**
- JWKS endpoint auto-discovered from `OIDC_ISSUER_URL/.well-known/openid-configuration`
- Key set cached in memory, refreshed when an unknown `kid` is encountered
- Clock skew tolerance: 30 seconds
- Required claims: `iss` (must match `OIDC_ISSUER_URL`), `aud` (must match `OIDC_AUDIENCE`), `exp`, `sub`

### Local Mode (No Auth)

When `AUTH_ENABLED=false` (default):
- JWT verification middleware skipped
- All requests attributed to a synthetic `local-user` with `admin` role
- No login page, no tokens
- Identical behavior to current codebase

This means a corporate developer can also run locally by simply not setting `AUTH_ENABLED`.

### Token Propagation to Agents

Agent containers currently receive API keys via environment variables. With OIDC:
- The **user's identity** (email, display name) is extracted from the JWT `sub`/`email`/`name` claims and stored on the Project record at creation time (`createdBy`, `createdByEmail`)
- Agent containers do NOT receive OIDC tokens — they use service-level API keys for AI providers
- The `GITHUB_TOKEN` / `BITBUCKET_TOKEN` remains a service account token configured per deployment (not per-user)
- Audit trail: all API mutations log `userId` extracted from the JWT

---

## 2. Role-Based Access Control (RBAC)

### Role Model

Four roles mapped to the team structure:

| Role | Description | Typical Users |
|------|-------------|---------------|
| `admin` | Full access, system configuration, user management | Tech Lead, Platform team |
| `operator` | Create projects, operate agents, dispatch tasks, manage repositories | Developers |
| `reviewer` | Approve specs/plans (PR approval), review PRs, view all projects | Tech Lead, QA, Senior Devs |
| `viewer` | Read-only access to projects, plans, execution status | Business Analysts, Stakeholders |

Roles are **not mutually exclusive** — a Tech Lead would have `admin` + `reviewer`. A developer would have `operator` + `reviewer`. When a user holds multiple roles, permissions are the **union** (any role granting access is sufficient).

### Permission Matrix

| Action | admin | operator | reviewer | viewer |
|--------|-------|----------|----------|--------|
| View projects / plans / execution | Y | Y | Y | Y |
| Create project | Y | Y | N | N |
| Delete project | Y | N | N | N |
| Configure repositories | Y | Y | N | N |
| Send chat messages (prompt agent) | Y | Y | N | N |
| Approve spec/plan (PR approval) | Y | N | Y | N |
| Retry failed project | Y | Y | N | N |
| Cancel project | Y | Y | N | N |
| View system settings (provider, model config — no secrets) | Y | Y | Y | Y |
| Modify system settings (provider, model) | Y | N | N | N |
| Manage users/roles | Y | N | N | N |

**Ownership override**: The creator of a project (`createdBy`) always has `operator`-level access to their own project, regardless of their assigned roles. This allows a user with only `viewer` role to still see projects they created.

### Implementation

**Role source**: JWT claims. The IdP includes a `roles` or `groups` claim in the access token. The backend's JWT verification middleware extracts these claims and maps them to harness roles on every request. Roles are always live — no caching, no stale sessions. The `users` table stores last-known roles for display/audit purposes only. There is no in-app role assignment; roles are managed exclusively in the IdP. If an admin needs to change a user's roles, they update the IdP group membership. The change takes effect immediately on the next token refresh (no re-login needed):

```
OIDC_ROLE_CLAIM=groups                              # or "roles", "realm_access.roles"
OIDC_ROLE_MAP_ADMIN=harness-admins
OIDC_ROLE_MAP_OPERATOR=harness-operators
OIDC_ROLE_MAP_REVIEWER=harness-reviewers
OIDC_ROLE_MAP_VIEWER=harness-viewers
```

**Note on PR approval**: The `reviewer` role grants spec/plan approval, which is performed by submitting a PR approval (GitHub "Approve" review / Bitbucket "Approve" button) on the planning PR. This replaces the previous LGTM-comment-based detection — PR approvals are a first-class VCS concept with proper audit trails, cannot be spoofed by non-reviewers (VCS enforces permissions), and integrate with branch protection rules. The polling loop detects approvals via the VCS connector's PR review API. Reviewers do not need chat access to approve.

**Middleware stack** (applied in order):
1. `verifyJwt()` — validates JWT signature, expiry, issuer, audience. Attaches decoded claims to `req.user`. Returns 401 if invalid/missing (skipped when `AUTH_ENABLED=false`).
2. `upsertUser()` — creates or updates `users` table row from JWT claims (sub, email, name, roles). Lightweight — only writes on first request per day or on role change.
3. `requireRole(...roles)` — checks `req.user.roles` against required roles. Returns 403 if insufficient. Applied per-route in `routes.ts`.

**Database changes**: New `users` table stores OIDC subject, email, display name, last login. Projects get `created_by` column. Agent sessions get `triggered_by`. All mutations include user attribution for audit.

---

## 3. Multi-Tenancy Model

### Shared Workspace

All users see all projects. No workspace isolation. This matches the team's operating model where squads collaborate and cross-review.

### Project Ownership

Each project has a `createdBy` user. The creator always has `operator`-level access to their own project (ownership override). Other users need appropriate roles. Typical flow:
- Developer (`operator`) creates a project with requirements from the BA
- Developer operates the agent → `operator` role
- TL/QA reviews and approves via PR comments → `reviewer` role
- BA and any squad member can see any project's status → `viewer` role

### Audit Trail

New `audit_log` table:

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,          -- 'project.create', 'project.delete', 'agent.prompt', 'plan.approve', etc.
  resource_type TEXT NOT NULL,   -- 'project', 'repository', 'agent_session'
  resource_id TEXT NOT NULL,
  details TEXT,                  -- JSON payload (request body summary)
  ip_address TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
```

This provides the traceability corporate security teams require.

---

## 4. Data Model Changes Summary

| Table | Change |
|-------|--------|
| `users` | **New** — `id` is the OIDC `sub` claim (stable across sessions). Email, display name, roles (JSON, cached from last token seen), last seen. |
| `projects` | Add `created_by TEXT REFERENCES users(id)` |
| `agent_sessions` | Add `triggered_by TEXT REFERENCES users(id)` |
| `audit_log` | **New** — full mutation audit trail |

**No `sessions` table** — the backend is stateless. Authentication state lives entirely in the client's JWT. This eliminates session store infrastructure (no Redis, no session cleanup crons) and makes the backend horizontally scalable without shared state.

---

## 5. Frontend Changes

| Area | Change |
|------|--------|
| OIDC client | Add `oidc-client-ts`. Handles authorization code + PKCE flow, token storage in `localStorage`, silent refresh via hidden iframe or refresh token, logout (revoke + clear storage). |
| Auth context | New `AuthProvider` React context wrapping the app. Provides `user`, `roles`, `isAuthenticated`, `login()`, `logout()`. Reads user info from decoded `id_token` claims. |
| API client | Fetch wrapper that attaches `Authorization: Bearer <access_token>` to all requests. On 401 response, attempts token refresh; if refresh fails, redirects to login. |
| Callback route | New `/auth/callback` frontend route handles IdP redirect, exchanges code for tokens, stores in `localStorage`, redirects to original URL. |
| Role-gated UI | Buttons/actions hidden or disabled based on role (decoded from token claims). E.g., "Delete" only visible to `admin`. "Send message" disabled for `viewer`. |
| User indicator | Nav bar shows logged-in user email/name from id_token claims. |
| Settings page | "Users" tab for `admin` role — list users from backend `/api/users`, see roles (read-only from IdP). |
| WebSocket | Pass access token as `?token=` query param on connect. Reconnect with fresh token when nearing expiry. |

---

## 6. Backwards Compatibility

The `AUTH_ENABLED=false` default ensures:
- Existing Docker Compose local setups work unchanged
- No migration required for local users
- Corporate deployment is opt-in via 3 env vars (`AUTH_ENABLED`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`)
- All new tables are created by the existing migration system (idempotent `CREATE TABLE IF NOT EXISTS`)
- No server-side session infrastructure — stateless backend scales horizontally with no additional dependencies
