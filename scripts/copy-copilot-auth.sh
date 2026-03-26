#!/usr/bin/env bash
# Authenticate with GitHub Copilot and write credentials into the harness-pi-auth volume.
#
# Prerequisites:
#   gh auth refresh --scopes "read:user"   # only needed once
#
# Usage: ./scripts/copy-copilot-auth.sh

set -euo pipefail

VOLUME=harness-pi-auth

# ── Resolve token: COPILOT_GITHUB_TOKEN > gh CLI ─────────────────────────────
# In CI: set COPILOT_GITHUB_TOKEN to a fine-grained PAT with "Copilot Requests" permission.
# Locally: run `gh auth refresh --scopes read:user` then this script uses gh auth token.
if [[ -n "${COPILOT_GITHUB_TOKEN:-}" ]]; then
  GH_TOKEN="$COPILOT_GITHUB_TOKEN"
  echo "Using COPILOT_GITHUB_TOKEN."
elif command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  GH_TOKEN=$(gh auth token 2>/dev/null)
  echo "Using gh CLI token."
else
  echo "ERROR: Set COPILOT_GITHUB_TOKEN (fine-grained PAT with 'Copilot Requests' permission)." >&2
  echo "  See: https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions" >&2
  exit 1
fi

python3 - <<PYEOF
import json, sys, time, urllib.request, subprocess

GH_TOKEN = "$GH_TOKEN"
VOLUME   = "$VOLUME"

COPILOT_HEADERS = {
    "Accept": "application/json",
    "Authorization": f"Bearer {GH_TOKEN}",
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
}

# ── Exchange gh token for Copilot token ───────────────────────────────────────
try:
    req = urllib.request.Request(
        "https://api.github.com/copilot_internal/v2/token",
        headers=COPILOT_HEADERS)
    with urllib.request.urlopen(req) as r:
        ct = json.loads(r.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    if e.code == 401 or "scope" in body.lower() or "read:user" in body.lower():
        print("ERROR: gh token lacks 'read:user' scope. Run:", file=sys.stderr)
        print("  gh auth refresh --scopes 'read:user'", file=sys.stderr)
    else:
        print(f"ERROR: {e.code} {body}", file=sys.stderr)
    sys.exit(1)

if "token" not in ct:
    print(f"ERROR: Unexpected response: {json.dumps(ct)}", file=sys.stderr)
    sys.exit(1)

access  = ct["token"]
expires = int(ct["expires_at"]) * 1000 - 5 * 60 * 1000
print(f"Copilot token obtained (expires in ~{int((expires/1000 - time.time())/60)} min).")

# ── Merge into existing auth.json in the volume ───────────────────────────────
read_proc = subprocess.run(
    ["docker", "run", "--rm", "-v", f"{VOLUME}:/pi-agent", "--entrypoint", "sh",
     "busybox", "-c", "cat /pi-agent/auth.json 2>/dev/null || echo {}"],
    capture_output=True, text=True)
existing = json.loads(read_proc.stdout.strip() or "{}")

existing["github-copilot"] = {
    "type": "oauth",
    "refresh": GH_TOKEN,   # gh token used to refresh the short-lived Copilot token
    "access": access,
    "expires": expires,
}

auth_json = json.dumps(existing, indent=2)
proc = subprocess.run(
    ["docker", "run", "--rm", "-i", "-v", f"{VOLUME}:/pi-agent",
     "--entrypoint", "sh", "busybox",
     "-c", "cat > /pi-agent/auth.json && chmod 600 /pi-agent/auth.json"],
    input=auth_json, text=True, capture_output=True)

if proc.returncode != 0:
    print(f"ERROR: Volume write failed: {proc.stderr}", file=sys.stderr)
    sys.exit(1)

print(f"Done. Credentials written to {VOLUME}:/pi-agent/auth.json")
print("Set: AGENT_PLANNING_MODEL=github-copilot/gpt-5-mini")
PYEOF
