#!/usr/bin/env bash
# Copy local Gemini CLI OAuth credentials into the harness-pi-auth Docker volume.
# Run once after `gemini` has authenticated locally (via `gemini auth login`).
#
# Usage: ./scripts/copy-gemini-auth.sh [project-id]
#
# project-id: Google Cloud project ID from ~/.gemini/projects.json
#             Defaults to the value for the current directory, or the first entry found.

set -euo pipefail

CREDS=~/.gemini/oauth_creds.json
PROJECTS=~/.gemini/projects.json
VOLUME=harness-pi-auth

if [[ ! -f "$CREDS" ]]; then
  echo "ERROR: $CREDS not found. Run 'gemini' and complete OAuth login first." >&2
  exit 1
fi

# Determine project ID: CLI arg > current dir entry > first entry
if [[ -n "${1:-}" ]]; then
  PROJECT_ID="$1"
elif [[ -f "$PROJECTS" ]]; then
  CWD=$(pwd)
  PROJECT_ID=$(python3 -c "
import json, sys
data = json.load(open('$PROJECTS'))
projects = data.get('projects', data)
# Try current directory, then parent, then first value
cwd = '$CWD'
for path, pid in projects.items():
    if cwd.startswith(path):
        print(pid)
        sys.exit(0)
# Fall back to first entry
if projects:
    print(next(iter(projects.values())))
    sys.exit(0)
print('')
" 2>/dev/null)
fi

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "ERROR: Could not determine Google Cloud project ID." >&2
  echo "       Pass it as an argument: $0 <project-id>" >&2
  exit 1
fi

echo "Using Google Cloud project: $PROJECT_ID"

# Build auth.json in pi-coding-agent format
AUTH_JSON=$(python3 - <<EOF
import json
creds = json.load(open('$CREDS'))
auth = {
    "google-gemini-cli": {
        "type": "oauth",
        "refresh": creds["refresh_token"],
        "access": creds["access_token"],
        "projectId": "$PROJECT_ID"
    }
}
print(json.dumps(auth, indent=2))
EOF
)

# Write into the Docker volume via a temporary container
echo "$AUTH_JSON" | docker run --rm -i \
  -v "${VOLUME}:/pi-agent" \
  --entrypoint sh \
  busybox \
  -c 'cat > /pi-agent/auth.json && chmod 600 /pi-agent/auth.json'

echo "Done. Credentials written to ${VOLUME}:/pi-agent/auth.json"
echo "Switch provider: AGENT_PLANNING_MODEL=google-gemini-cli/gemini-2.5-pro"
