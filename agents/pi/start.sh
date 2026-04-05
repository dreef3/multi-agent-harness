#!/bin/sh
# Harness uses "copilot" as the short provider name; pi expects "github-copilot".
if [ "${AGENT_PROVIDER:-}" = "copilot" ]; then
  export AGENT_PROVIDER=github-copilot
fi

# Seed pi's auth.json from COPILOT_GITHUB_TOKEN so pi-acp can authenticate.
# Fine-grained GitHub PATs work directly as Bearer tokens against
# api.individual.githubcopilot.com — no session token exchange is needed.
# Expiry is set 1 year out so pi-ai never auto-refreshes during a run.

if [ -n "${COPILOT_GITHUB_TOKEN}" ]; then
  PI_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
  AUTH_FILE="${PI_DIR}/auth.json"

  mkdir -p "${PI_DIR}"
  # Use the PAT directly as the access token — no exchange needed.
  # Fine-grained PATs work as Bearer tokens against api.individual.githubcopilot.com.
  # Expiry is set 1 year out so pi-ai never tries to refresh during a run.
  AUTH_FILE="${AUTH_FILE}" node -e "
    const fs = require('fs');
    const authPath = process.env.AUTH_FILE;
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
    existing['github-copilot'] = {
      type: 'oauth',
      refresh: process.env.COPILOT_GITHUB_TOKEN,
      access: process.env.COPILOT_GITHUB_TOKEN,
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    };
    fs.writeFileSync(authPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    process.stderr.write('[start] Copilot auth seeded from COPILOT_GITHUB_TOKEN\n');
  " 2>&1
fi

# ── Sub-agent mode ────────────────────────────────────────────────────────────
# When TASK_DESCRIPTION is set the container was launched by taskDispatcher to
# execute a single implementation task.  Run pi in non-interactive (--print)
# mode, then push any changes and report status to the harness API.
if [ -n "${TASK_DESCRIPTION}" ]; then
  echo "[start] Sub-agent mode: cloning repo and executing task" >&2

  # Save authenticated push URL then remove it from env so the AI never sees
  # the embedded token.  Git remote 'origin' is set to the same URL so pi can
  # push via normal git commands.
  PUSH_URL="${GIT_PUSH_URL}"
  unset GIT_PUSH_URL

  # Clone the repository into /workspace
  git clone "${PUSH_URL}" /workspace 2>&1
  if [ $? -ne 0 ]; then
    echo "[start] git clone failed" >&2
    curl -s -X PATCH "${HARNESS_API_URL}/api/sessions/${AGENT_SESSION_ID}" \
      -H 'Content-Type: application/json' \
      -d '{"status":"failed"}' >/dev/null 2>&1
    exit 1
  fi
  cd /workspace

  # Checkout the branch already created by the harness
  git checkout "${BRANCH_NAME}" 2>&1 || git checkout -b "${BRANCH_NAME}" 2>&1

  # Point origin at the authenticated URL so pi can git push if it wants to
  git remote set-url origin "${PUSH_URL}"

  # Set a neutral git identity for commits
  git config user.email "harness-sub-agent@harness.local"
  git config user.name "Harness Sub-Agent"

  # AGENT_PROVIDER is already normalised at the top of this script.
  # "pi" is an additional alias used by the harness internally.
  PROVIDER="${AGENT_PROVIDER:-github-copilot}"
  [ "${PROVIDER}" = "pi" ] && PROVIDER="github-copilot"

  # Extract task and clear from env before running AI
  TASK_TEXT="${TASK_DESCRIPTION}"
  unset TASK_DESCRIPTION

  # Run pi in non-interactive (--print) mode.
  # --no-session avoids writing a session file to disk.
  # The implementation AGENTS.md is appended to the system prompt.
  SYSTEM_ADDENDUM=""
  [ -f "/agent-data/implementation/AGENTS.md" ] && SYSTEM_ADDENDUM="$(cat /agent-data/implementation/AGENTS.md)"

  printf '%s' "${TASK_TEXT}" | \
    /app/node_modules/.bin/pi \
      --print \
      --no-session \
      --provider "${PROVIDER}" \
      --model "${AGENT_MODEL:-gpt-5-mini}" \
      ${SYSTEM_ADDENDUM:+--append-system-prompt "${SYSTEM_ADDENDUM}"}

  PI_EXIT=$?
  echo "[start] pi exited with code ${PI_EXIT}" >&2

  if [ $PI_EXIT -eq 0 ]; then
    # Push any uncommitted changes (pi may have already pushed; this is a no-op if so)
    git push origin "${BRANCH_NAME}" 2>&1 || echo "[start] git push had no new changes" >&2

    curl -s -X PATCH "${HARNESS_API_URL}/api/sessions/${AGENT_SESSION_ID}" \
      -H 'Content-Type: application/json' \
      -d '{"status":"completed"}' >/dev/null 2>&1
    exit 0
  else
    curl -s -X PATCH "${HARNESS_API_URL}/api/sessions/${AGENT_SESSION_ID}" \
      -H 'Content-Type: application/json' \
      -d '{"status":"failed"}' >/dev/null 2>&1
    exit 1
  fi
fi

# ── Planning agent mode ───────────────────────────────────────────────────────
# No TASK_DESCRIPTION: this is a long-lived ACP server connected to the harness
# backend via the TCP bridge.
exec node /app/stdio-tcp-bridge.mjs /app/node_modules/.bin/pi-acp
