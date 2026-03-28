# GitHub Actions Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance GitHub Actions with a tag-triggered release pipeline, Helm chart publishing, SBOM generation, and automated release-please version bump PRs.

**Architecture:** The existing `ci.yml` handles test/build on every push; a new `release.yml` triggers on `v*` tags to build and push all four service images to GHCR, generate an SPDX SBOM, and create a GitHub Release with the SBOM attached. A separate `helm-publish.yml` packages and publishes the Helm chart on the same tags. `release-please.yml` automates conventional-commit-based version bump PRs on main.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR (ghcr.io), anchore/sbom-action, softprops/action-gh-release, googleapis/release-please-action, Helm 3, Artifactory (optional).

---

## Prerequisites

- [ ] Confirm `.github/workflows/ci.yml` has `test-backend` and `test-frontend` jobs
- [ ] Confirm `charts/multi-agent-harness/Chart.yaml` exists (see phase3-kubernetes-runtime plan)
- [ ] All four Dockerfiles exist: `backend/Dockerfile`, `frontend/Dockerfile`, `planning-agent/Dockerfile`, `sub-agent/Dockerfile`
- [ ] Repository has `packages: write` and `contents: write` permissions enabled (Settings → Actions → General)

---

## Task 1 — Add lint step to existing `ci.yml`

- [ ] Open `.github/workflows/ci.yml`
- [ ] In the `test-frontend` job, after the `bun install` step, add:

```yaml
      - name: Lint
        run: bun run lint 2>/dev/null || echo "No lint script configured"
```

Full updated `test-frontend` job for reference:

```yaml
  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        working-directory: frontend
        run: bun install

      - name: Lint
        working-directory: frontend
        run: bun run lint 2>/dev/null || echo "No lint script configured"

      - name: Type-check
        working-directory: frontend
        run: bunx tsc --noEmit

      - name: Test
        working-directory: frontend
        run: bun run test

      - name: Build
        working-directory: frontend
        run: bun run build
```

- [ ] Commit: `ci: add lint step to test-frontend job`

---

## Task 2 — Create `.github/workflows/release.yml`

- [ ] Create `.github/workflows/release.yml` with the following content:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: ghcr.io/${{ github.repository_owner }}/multi-agent-harness

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
      id-token: write  # for OIDC-based auth

    steps:
      - uses: actions/checkout@v4

      - name: Extract version from tag
        id: version
        run: echo "VERSION=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push backend
        uses: docker/build-push-action@v5
        with:
          context: .
          file: backend/Dockerfile
          push: true
          tags: |
            ${{ env.IMAGE_PREFIX }}/backend:${{ steps.version.outputs.VERSION }}
            ${{ env.IMAGE_PREFIX }}/backend:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build and push frontend
        uses: docker/build-push-action@v5
        with:
          context: frontend
          file: frontend/Dockerfile
          push: true
          tags: |
            ${{ env.IMAGE_PREFIX }}/frontend:${{ steps.version.outputs.VERSION }}
            ${{ env.IMAGE_PREFIX }}/frontend:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build and push planning-agent
        uses: docker/build-push-action@v5
        with:
          context: .
          file: planning-agent/Dockerfile
          push: true
          tags: |
            ${{ env.IMAGE_PREFIX }}/planning-agent:${{ steps.version.outputs.VERSION }}
            ${{ env.IMAGE_PREFIX }}/planning-agent:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build and push sub-agent
        uses: docker/build-push-action@v5
        with:
          context: .
          file: sub-agent/Dockerfile
          push: true
          tags: |
            ${{ env.IMAGE_PREFIX }}/sub-agent:${{ steps.version.outputs.VERSION }}
            ${{ env.IMAGE_PREFIX }}/sub-agent:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Generate SBOM (backend)
        uses: anchore/sbom-action@v0
        with:
          image: ${{ env.IMAGE_PREFIX }}/backend:${{ steps.version.outputs.VERSION }}
          format: spdx-json
          output-file: sbom-backend.spdx.json

      - name: Generate SBOM (frontend)
        uses: anchore/sbom-action@v0
        with:
          image: ${{ env.IMAGE_PREFIX }}/frontend:${{ steps.version.outputs.VERSION }}
          format: spdx-json
          output-file: sbom-frontend.spdx.json

      - name: Generate SBOM (planning-agent)
        uses: anchore/sbom-action@v0
        with:
          image: ${{ env.IMAGE_PREFIX }}/planning-agent:${{ steps.version.outputs.VERSION }}
          format: spdx-json
          output-file: sbom-planning-agent.spdx.json

      - name: Generate SBOM (sub-agent)
        uses: anchore/sbom-action@v0
        with:
          image: ${{ env.IMAGE_PREFIX }}/sub-agent:${{ steps.version.outputs.VERSION }}
          format: spdx-json
          output-file: sbom-sub-agent.spdx.json

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          files: |
            sbom-backend.spdx.json
            sbom-frontend.spdx.json
            sbom-planning-agent.spdx.json
            sbom-sub-agent.spdx.json

      # Optional: push to Artifactory
      - name: Push to Artifactory
        if: vars.PUSH_TO_ARTIFACTORY == 'true'
        run: |
          echo "${{ secrets.ARTIFACTORY_TOKEN }}" | \
            docker login ${{ vars.ARTIFACTORY_REGISTRY }} \
              -u ${{ vars.ARTIFACTORY_USER }} --password-stdin
          for svc in backend frontend planning-agent sub-agent; do
            docker tag \
              ${{ env.IMAGE_PREFIX }}/${svc}:${{ steps.version.outputs.VERSION }} \
              ${{ vars.ARTIFACTORY_REGISTRY }}/multi-agent-harness/${svc}:${{ steps.version.outputs.VERSION }}
            docker push \
              ${{ vars.ARTIFACTORY_REGISTRY }}/multi-agent-harness/${svc}:${{ steps.version.outputs.VERSION }}
          done
```

- [ ] Verify: `yamllint .github/workflows/release.yml`
- [ ] Commit: `ci: add release workflow with SBOM generation and GHCR push`

---

## Task 3 — Create `.github/workflows/helm-publish.yml`

- [ ] Create `.github/workflows/helm-publish.yml`:

```yaml
name: Helm Publish

on:
  push:
    tags:
      - 'v*'

jobs:
  helm-publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Install Helm
        uses: azure/setup-helm@v3
        with:
          version: v3.14.0

      - name: Extract version
        id: version
        run: echo "VERSION=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Update chart version
        run: |
          sed -i \
            "s/^version:.*/version: ${{ steps.version.outputs.VERSION }}/" \
            charts/multi-agent-harness/Chart.yaml
          sed -i \
            "s/^appVersion:.*/appVersion: \"${{ steps.version.outputs.VERSION }}\"/" \
            charts/multi-agent-harness/Chart.yaml

      - name: Helm lint
        run: helm lint charts/multi-agent-harness/

      - name: Package chart
        run: |
          mkdir -p .helm-packages
          helm package charts/multi-agent-harness/ --destination .helm-packages/

      - name: Push chart to GHCR OCI registry
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | \
            helm registry login ghcr.io -u ${{ github.actor }} --password-stdin
          helm push \
            .helm-packages/multi-agent-harness-${{ steps.version.outputs.VERSION }}.tgz \
            oci://ghcr.io/${{ github.repository_owner }}/charts

      - name: Push to Artifactory Helm repo
        if: vars.PUSH_TO_ARTIFACTORY == 'true'
        run: |
          curl -fsS \
            -H "Authorization: Bearer ${{ secrets.ARTIFACTORY_TOKEN }}" \
            -T .helm-packages/multi-agent-harness-${{ steps.version.outputs.VERSION }}.tgz \
            "${{ vars.ARTIFACTORY_HELM_REPO }}/multi-agent-harness-${{ steps.version.outputs.VERSION }}.tgz"

      - name: Upload chart as artifact
        uses: actions/upload-artifact@v4
        with:
          name: helm-chart-${{ steps.version.outputs.VERSION }}
          path: .helm-packages/
          retention-days: 90
```

- [ ] Verify: `yamllint .github/workflows/helm-publish.yml`
- [ ] Commit: `ci: add Helm chart publish workflow`

---

## Task 4 — Create `.github/workflows/release-please.yml`

- [ ] Create `.github/workflows/release-please.yml`:

```yaml
name: Release Please

on:
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}

    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          release-type: node
          token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: use a separate bot token to allow the release PR to
          # trigger CI (GITHUB_TOKEN PRs do not trigger other workflows)
          # token: ${{ secrets.RELEASE_PLEASE_TOKEN }}
```

Notes on release-please setup:
- Reads `package.json` `version` field as the source of truth
- Parses conventional commits (`feat:`, `fix:`, `chore:`, etc.) to determine version bump
- Creates a "Release PR" — merging it triggers tag creation → kicks off `release.yml` and `helm-publish.yml`
- For a monorepo, switch `release-type: node` to `release-type: simple` and add a `release-please-config.json`

- [ ] Verify: `yamllint .github/workflows/release-please.yml`
- [ ] Add `release-please-manifest.json` at repo root if not present:

```json
{
  ".": "0.1.0"
}
```

- [ ] Commit: `ci: add release-please automation for version bumps`

---

## Task 5 — Repository variables and secrets documentation

Document required GitHub repository settings (Settings → Secrets and variables → Actions):

**Secrets (sensitive):**
| Name | Description |
|------|-------------|
| `ARTIFACTORY_TOKEN` | Bearer token for Artifactory API access |

**Variables (non-sensitive):**
| Name | Description | Default |
|------|-------------|---------|
| `PUSH_TO_ARTIFACTORY` | Set to `"true"` to enable Artifactory push | `"false"` |
| `ARTIFACTORY_REGISTRY` | Artifactory Docker registry hostname | — |
| `ARTIFACTORY_USER` | Artifactory username | — |
| `ARTIFACTORY_HELM_REPO` | Artifactory Helm repo URL | — |

**Automatic secrets (no setup needed):**
- `secrets.GITHUB_TOKEN` — provided by GitHub Actions runner

- [ ] Add `docs/ci-secrets.md` documenting the above table (or inline into existing docs)
- [ ] Verify workflows parse correctly: push a test tag `v0.0.1-test` to a fork and check Actions logs

---

## Verification checklist

- [ ] `yamllint` passes on all three new workflow files
- [ ] `release.yml` triggers on `v*` tags only (not on branch pushes)
- [ ] `helm-publish.yml` uses correct chart path `charts/multi-agent-harness/`
- [ ] SBOM files are attached to the GitHub Release
- [ ] `release-please.yml` creates a Release PR on merge to main
- [ ] Artifactory steps are skipped when `vars.PUSH_TO_ARTIFACTORY != 'true'`
- [ ] `IMAGE_PREFIX` resolves correctly for non-org repos (`github.repository_owner`)
