# CI/CD Secrets and Variables

Configure these in **Settings → Secrets and variables → Actions** in the GitHub repository.

## Secrets (sensitive values)

| Name | Description |
|------|-------------|
| `ARTIFACTORY_TOKEN` | Bearer token for Artifactory API access (Docker push + Helm upload) |

## Variables (non-sensitive)

| Name | Description | Default |
|------|-------------|---------|
| `PUSH_TO_ARTIFACTORY` | Set to `"true"` to enable Artifactory push steps | `"false"` |
| `ARTIFACTORY_REGISTRY` | Artifactory Docker registry hostname (e.g. `corp.artifactory.com/docker-local`) | — |
| `ARTIFACTORY_USER` | Artifactory username for Docker login | — |
| `ARTIFACTORY_HELM_REPO` | Artifactory Helm repo URL for chart upload | — |

## Automatic secrets (no setup needed)

| Name | Description |
|------|-------------|
| `secrets.GITHUB_TOKEN` | Provided by the GitHub Actions runner; used for GHCR push and GitHub Releases |

## Workflow overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to main/PR | Run tests, type-check, build |
| `release.yml` | Push `v*` tag | Build + push all images to GHCR, generate SBOMs, create GitHub Release |
| `helm-publish.yml` | Push `v*` tag | Package and push Helm chart to GHCR OCI registry |
| `release-please.yml` | Push to main | Automate version bump PRs via conventional commits |

## Release process

1. Merge PRs to `main` with conventional commit messages (`feat:`, `fix:`, `chore:`)
2. `release-please` opens a Release PR with bumped version and changelog
3. Merge the Release PR → `release-please` creates a `v*` tag
4. `release.yml` and `helm-publish.yml` trigger automatically on the tag
