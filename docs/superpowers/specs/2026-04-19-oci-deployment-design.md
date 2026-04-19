# OCI Deployment Design

**Date:** 2026-04-19  
**Status:** Approved

## Summary

Deploy the multi-agent harness to a single Oracle Cloud Infrastructure (OCI) ARM VM (Always Free tier) using Terraform for provisioning and GitHub Actions for CI/CD. Access is via Tailscale MagicDNS only — no public ports exposed for the app. Every push to `main` triggers a full deploy.

## Architecture

```
GitHub Actions
  ├── terraform apply       → OCI ARM VM (4 OCPU, 24 GB, Ubuntu 22.04)
  ├── docker build + push   → GHCR (linux/arm64 images)
  └── SSH via Tailscale     → docker compose up -d

OCI VM (oci-harness)
  ├── Docker + Compose
  ├── Tailscale (MagicDNS: oci-harness)
  └── /opt/harness/
        ├── docker-compose.yml
        ├── docker-compose.prod.yml
        └── .env
```

## Components

### Terraform (`terraform/`)

Manages OCI infrastructure:

- **VCN** `10.0.0.0/16` with a single public subnet `10.0.0.0/24`
- **Internet gateway** + route table (required for outbound Docker/Tailscale/apt traffic)
- **Security list**: TCP:22 inbound (SSH safety valve), all egress. App ports (9999, 3000) are intentionally not opened — access is Tailscale-only.
- **Compute instance**: `VM.Standard.A1.Flex`, 4 OCPU, 24 GB RAM, Ubuntu 22.04 ARM (latest image resolved via data source), 50 GB boot volume
- **Cloud-init**: installs Docker CE, Tailscale (joins tailnet with auth key), creates `deploy` user with SSH key, creates `/opt/harness`

**State backend**: OCI Object Storage via S3-compatible API. Bucket must be pre-created once (see First-Time Setup). Partial backend config — connection args passed as `-backend-config` flags in CI.

`lifecycle.ignore_changes` on `source_details.source_id` prevents VM recreation when a new Ubuntu image is released.

### GitHub Actions (`.github/workflows/deploy.yml`)

Three jobs run on every push to `main`:

| Job | What it does |
|-----|-------------|
| `terraform` | `terraform apply -auto-approve` — no-op if VM exists |
| `build` | Builds `backend` and `frontend` images for `linux/arm64`, pushes to GHCR |
| `deploy` | Joins Tailscale, waits for VM, copies compose + `.env`, runs `docker compose pull && up -d` |

`deploy` blocks on both `terraform` and `build` completing successfully.

### Production Compose (`docker-compose.prod.yml`)

Overrides `image:` in the base compose to use GHCR images (`${GHCR_PREFIX}/backend:latest`, `${GHCR_PREFIX}/frontend:latest`) with `pull_policy: always`. Merged at runtime: `docker compose -f docker-compose.yml -f docker-compose.prod.yml`.

The `postgres` service (behind `enterprise` profile) and all `build-only` agent images are not started.

### Database

SQLite, persisted in the `harness-data` named Docker volume on the VM's boot disk.

## Secrets & Variables

### GitHub Actions Secrets

| Secret | Description |
|--------|-------------|
| `OCI_TENANCY_OCID` | Tenancy OCID |
| `OCI_USER_OCID` | API user OCID |
| `OCI_FINGERPRINT` | API key fingerprint |
| `OCI_PRIVATE_KEY` | API private key (PEM, full content) |
| `OCI_REGION` | OCI region identifier (e.g. `eu-frankfurt-1`) |
| `OCI_COMPARTMENT_ID` | Compartment OCID for all resources |
| `OCI_NAMESPACE` | Object Storage namespace (from OCI console) |
| `OCI_STATE_ACCESS_KEY` | Customer Secret Key ID for S3-compatible state backend |
| `OCI_STATE_SECRET_KEY` | Customer Secret Key secret |
| `VM_SSH_PUBLIC_KEY` | SSH public key deployed to `deploy` user |
| `VM_SSH_PRIVATE_KEY` | Corresponding SSH private key for GHA to SSH in |
| `TAILSCALE_AUTH_KEY` | Reusable Tailscale auth key for the VM (tag: `tag:server`) |
| `TAILSCALE_OAUTH_CLIENT_ID` | Tailscale OAuth client ID for GHA runner |
| `TAILSCALE_OAUTH_SECRET` | Tailscale OAuth client secret for GHA runner |
| `GHCR_TOKEN` | GitHub PAT with `read:packages` — used by VM to pull images |
| `ANTHROPIC_API_KEY` | Claude API key written to `.env` |
| `DEPLOY_GITHUB_TOKEN` | GitHub PAT for the harness app (written to `.env`) |

### GitHub Actions Variables (non-secret)

| Variable | Description |
|----------|-------------|
| `OCI_STATE_BUCKET` | Object Storage bucket name (e.g. `terraform-state`) |
| `VM_TAILSCALE_HOST` | MagicDNS hostname of the VM (e.g. `oci-harness`) |

## First-Time Setup

1. **OCI Object Storage bucket** — create manually once in the OCI console. Name it `terraform-state` (or set `OCI_STATE_BUCKET` to whatever you name it).

2. **OCI API key** — generate in OCI console → Identity → Users → your user → API Keys. Note the OCID, tenancy OCID, fingerprint, and download the private key.

3. **Customer Secret Key** — in OCI console → your user → Customer Secret Keys. This is the S3-compatible credential for Terraform state.

4. **SSH key pair** — generate locally:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/oci-harness -N ""
   ```
   Set `VM_SSH_PUBLIC_KEY` to the `.pub` content, `VM_SSH_PRIVATE_KEY` to the private key content.

5. **Tailscale auth key** — in Tailscale admin → Settings → Keys → Generate auth key. Make it reusable and tag it `tag:server`. Set as `TAILSCALE_AUTH_KEY`.

6. **Tailscale OAuth client** — in Tailscale admin → Settings → OAuth clients. Scope: `devices:write`. Tag: `tag:ci`. Set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_SECRET`.

7. **GHCR token** — create a GitHub PAT (classic or fine-grained) with `read:packages`. Set as `GHCR_TOKEN`. (GHA's own `GITHUB_TOKEN` can push images but the VM needs a separate token to pull them.)

8. **Push to main** — the first run provisions the VM and deploys. Cloud-init takes 2-3 minutes; the deploy job's wait loop handles this.

9. **Set `VM_TAILSCALE_HOST`** — after the first run, the VM joins the tailnet as `oci-harness`. Set the `VM_TAILSCALE_HOST` variable in GitHub Actions to this hostname (or its full MagicDNS FQDN if needed).

## Access

Once running, the app is available at `http://oci-harness:9999` from any device on the tailnet. No TLS is needed within Tailscale (traffic is encrypted by WireGuard).

## Agent Images

The `build` job currently only builds `backend` and `frontend` (the only services active in production compose). Agent images (`agent-pi`, `agent-claude`, etc.) are built locally and tagged as `build-only` in compose — they are not auto-deployed. If agent containers are needed on OCI, add their image builds to the `build` job and a `docker-compose.agents.yml` override.
