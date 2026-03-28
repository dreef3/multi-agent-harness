# Enterprise: Authentication, Authorization & Multi-Tenancy

## Current State

The harness has **zero authentication**. All API endpoints and WebSocket connections are open. There is no concept of users, roles, or permissions. Any network-adjacent client can create projects, trigger agents, and read all data.

This is acceptable for single-developer local use but blocks any shared or corporate deployment.

## Target State

Shared workspace visible to all 3 squads (Tech Lead, Business Analysts, QA, Developers). OIDC-based authentication for corporate deployments. No auth required for local mode. Role-based access control governs who can perform which actions.

---

## 1. Authentication

### OIDC Integration

Add an OIDC Relying Party to the backend. The frontend redirects unauthenticated users to the corporate identity provider (Keycloak, Azure AD, Okta, etc.).

**Flow:**
```
Browser → Frontend → /api/auth/login → 302 to IdP
IdP authenticates → callback to /api/auth/callback
Backend validates ID token → issues session cookie (httpOnly, secure, SameSite=Strict)
All subsequent API/WS requests carry session cookie
```

**Implementation approach:**

| Component | Change |
|-----------|--------|
| Backend | Add `passport` + `passport-openidconnect` (or lighter `openid-client`). Session store in SQLite (new `sessions` table) or Redis if available. |
| Frontend | Add auth context provider. Redirect to `/api/auth/login` when 401 received. Store user display name/email in React state from `/api/auth/me`. |
| WebSocket | Validate session cookie on upgrade request. Reject with 401 if invalid. |
| nginx | Pass `Cookie` header through to backend (already does via `proxy_set_header`). |

**Configuration (env vars):**
```
AUTH_ENABLED=true|false          # Master switch (false for local mode)
OIDC_ISSUER_URL=https://idp.corp.example.com/realms/harness
OIDC_CLIENT_ID=multi-agent-harness
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=https://harness.corp.example.com/api/auth/callback
SESSION_SECRET=<random>
SESSION_TTL_HOURS=8              # Work-day session length
```

### Local Mode (No Auth)

When `AUTH_ENABLED=false` (default):
- No OIDC middleware loaded
- All requests attributed to a synthetic `local-user` with `admin` role
- No login page, no session cookies
- Identical behavior to current codebase

This means a corporate developer can also run locally by simply not setting `AUTH_ENABLED`.

### Token Propagation to Agents

Agent containers currently receive API keys via environment variables. With OIDC:
- The **user's identity** (email, display name) is stored on the Project record at creation time (`createdBy`, `createdByEmail`)
- Agent containers do NOT receive OIDC tokens — they use service-level API keys for AI providers
- The `GITHUB_TOKEN` / `BITBUCKET_TOKEN` remains a service account token configured per deployment (not per-user)
- Audit trail: all API mutations log `userId` from the session

---

## 2. Role-Based Access Control (RBAC)

### Role Model

Four roles mapped to the team structure:

| Role | Description | Typical Users |
|------|-------------|---------------|
| `admin` | Full access, system configuration, user management | Tech Lead, Platform team |
| `operator` | Create projects, operate agents, dispatch tasks, manage repositories | Developers |
| `reviewer` | Approve specs/plans (LGTM), review PRs, view all projects | Tech Lead, QA, Senior Devs |
| `viewer` | Read-only access to projects, plans, execution status | Business Analysts, Stakeholders |

Roles are **not mutually exclusive** — a Tech Lead would have `admin` + `reviewer`. A developer would have `operator` + `reviewer`.

### Permission Matrix

| Action | admin | operator | reviewer | viewer |
|--------|-------|----------|----------|--------|
| View projects / plans / execution | Y | Y | Y | Y |
| Create project | Y | Y | N | N |
| Delete project | Y | N | N | N |
| Configure repositories | Y | Y | N | N |
| Send chat messages (prompt agent) | Y | Y | N | N |
| Approve spec/plan (LGTM) | Y | N | Y | N |
| Retry failed project | Y | Y | N | N |
| Cancel project | Y | Y | N | N |
| View system settings | Y | Y | Y | Y |
| Modify system settings (provider, model) | Y | N | N | N |
| Manage users/roles | Y | N | N | N |

### Implementation

**Role source**: OIDC claims. The IdP includes a `roles` or `groups` claim in the ID token. A mapping configuration maps IdP groups to harness roles:

```
OIDC_ROLE_CLAIM=groups                              # or "roles", "realm_access.roles"
OIDC_ROLE_MAP_ADMIN=harness-admins
OIDC_ROLE_MAP_OPERATOR=harness-operators
OIDC_ROLE_MAP_REVIEWER=harness-reviewers
OIDC_ROLE_MAP_VIEWER=harness-viewers
```

**Middleware**: A `requireRole(...roles)` Express middleware checks the session's roles before allowing the request. Applied per-route in `routes.ts`.

**Database changes**: New `users` table stores OIDC subject, email, display name, last login. Projects get `created_by` column. Agent sessions get `triggered_by`. All mutations include user attribution for audit.

---

## 3. Multi-Tenancy Model

### Shared Workspace

All users see all projects. No workspace isolation. This matches the team's operating model where squads collaborate and cross-review.

### Project Ownership

Each project has a `createdBy` user. The creator can always operate their own project. Other users need appropriate roles. This enables:
- BA creates a project with requirements → `viewer` role sufficient to see it
- Developer operates the agent → `operator` role
- TL/QA reviews and approves → `reviewer` role
- Any squad member can see any project's status → `viewer`

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
| `users` | **New** — OIDC subject, email, display name, roles (JSON), last login |
| `projects` | Add `created_by TEXT REFERENCES users(id)` |
| `agent_sessions` | Add `triggered_by TEXT REFERENCES users(id)` |
| `audit_log` | **New** — full mutation audit trail |
| `sessions` | **New** — server-side session store (alternative: use Redis) |

---

## 5. Frontend Changes

| Area | Change |
|------|--------|
| Auth context | New `AuthProvider` React context wrapping the app. Provides `user`, `roles`, `isAuthenticated`. |
| Login redirect | If `/api/auth/me` returns 401, redirect to `/api/auth/login`. |
| Role-gated UI | Buttons/actions hidden or disabled based on role. E.g., "Delete" only visible to `admin`. "Send message" disabled for `viewer`. |
| User indicator | Nav bar shows logged-in user email/avatar. |
| Settings page | "Users" tab for `admin` role — list users, see roles (read-only from IdP). |

---

## 6. Backwards Compatibility

The `AUTH_ENABLED=false` default ensures:
- Existing Docker Compose local setups work unchanged
- No migration required for local users
- Corporate deployment is opt-in via environment configuration
- All new tables are created by the existing migration system (idempotent `CREATE TABLE IF NOT EXISTS`)
