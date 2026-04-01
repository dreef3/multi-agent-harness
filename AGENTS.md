# Multi-Agent Harness — Agent Configuration

## Package Manager

**Use `bun` for all package management.** Do not use `npm` or `yarn`.

| Location | Package Manager | Notes |
|---|---|---|
| Root workspace | `bun install` | Covers `backend`, `frontend`, `e2e-tests` workspaces |
| `backend/` | `bun install` | Part of root workspace; `bun.lock` lives at root |
| `frontend/` | `bun install` | Part of root workspace; `bun.lock` lives at root |
| `e2e-tests/` | `bun install` | Part of root workspace; `bun.lock` lives at root |
| `planning-agent/` | `bun install` | Standalone package (not in root workspaces); has its own `bun.lock` |

### Running tests

```bash
# Backend tests
bun run --cwd backend test

# Frontend tests
bun run --cwd frontend test

# E2E tests
bun run e2e
```

### Adding/updating a dependency

```bash
# In a workspace package (backend, frontend, etc.)
cd backend && bun add <package>
# or from root:
bun add --cwd backend <package>
```

### Lock files

- Root `bun.lock` — shared by `backend`, `frontend`, `e2e-tests`
- `planning-agent/bun.lock` — independent (planning-agent is not in root workspaces)
- `package-lock.json` at root — legacy artifact; do not update with npm

## Repository Layout

```
multi-agent-harness/
├── backend/          # Node/Express API + SQLite/Postgres store
├── frontend/         # React/Vite SPA
├── e2e-tests/        # Playwright end-to-end tests
├── planning-agent/   # Standalone planning agent container
└── docker-compose.yml
```

## Environment Variables

Copy `.env.example` to `.env` at the repo root. Key variables:

- `AUTH_ENABLED` — default `false`; set to `true` to enable OIDC JWT verification
- `OIDC_ISSUER_URL` — OIDC provider discovery URL
- `DATABASE_TYPE` — `sqlite` (default) or `postgres`
- `DATABASE_URL` — PostgreSQL connection string (when `DATABASE_TYPE=postgres`)
