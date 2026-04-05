#!/bin/sh
# pi-acp uses AGENT_PROVIDER=github-copilot; harness passes AGENT_PROVIDER=copilot — remap it.
if [ "${AGENT_PROVIDER:-}" = "copilot" ]; then
  export AGENT_PROVIDER=github-copilot
fi

# Exchange COPILOT_GITHUB_TOKEN for a Copilot session token and write it to
# pi's auth.json so that pi can make authenticated Copilot API calls.
# Falls back to using the PAT directly if the exchange fails (fine-grained PATs
# work as Bearer tokens against api.individual.githubcopilot.com).
if [ -n "${COPILOT_GITHUB_TOKEN}" ]; then
  PI_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
  AUTH_FILE="${PI_DIR}/auth.json"

  if [ ! -f "${AUTH_FILE}" ]; then
    mkdir -p "${PI_DIR}"
    RESP_FILE=$(mktemp /tmp/copilot-XXXXXX.json)

    HTTP_CODE=$(curl -s -o "${RESP_FILE}" -w "%{http_code}" \
      "https://api.github.com/copilot_internal/v2/token" \
      -H "Authorization: Bearer ${COPILOT_GITHUB_TOKEN}" \
      -H "Accept: application/json" \
      -H "User-Agent: GitHubCopilotChat/0.35.0" \
      -H "Editor-Version: vscode/1.107.0" \
      -H "Editor-Plugin-Version: copilot-chat/0.35.0" \
      -H "Copilot-Integration-Id: copilot-developer-cli" 2>/dev/null) || HTTP_CODE=0

    if [ "${HTTP_CODE}" = "200" ]; then
      RESP_FILE="${RESP_FILE}" AUTH_FILE="${AUTH_FILE}" node -e "
        try {
          const d = JSON.parse(require('fs').readFileSync(process.env.RESP_FILE, 'utf8'));
          if (d.token && d.expires_at) {
            const auth = {
              'github-copilot': {
                type: 'oauth',
                refresh: process.env.COPILOT_GITHUB_TOKEN,
                access: d.token,
                expires: d.expires_at * 1000 - 5 * 60 * 1000,
                enterpriseUrl: null
              }
            };
            require('fs').writeFileSync(process.env.AUTH_FILE,
              JSON.stringify(auth, null, 2), { mode: 0o600 });
            process.stderr.write('[start] Copilot auth initialized via session token\n');
          } else {
            process.stderr.write('[start] Copilot token response missing fields\n');
          }
        } catch (e) {
          process.stderr.write('[start] Copilot auth init error: ' + e.message + '\n');
        }
        try { require('fs').unlinkSync(process.env.RESP_FILE); } catch {}
      " 2>&1
    else
      echo "[start] Copilot session token exchange failed (HTTP ${HTTP_CODE}), falling back to PAT" >&2
      rm -f "${RESP_FILE}"
    fi

    # If auth file still doesn't exist after exchange attempt, seed PAT directly.
    # Fine-grained PATs work as Bearer tokens against api.individual.githubcopilot.com.
    if [ ! -f "${AUTH_FILE}" ]; then
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
        process.stderr.write('[start] Copilot auth seeded from PAT (fallback)\n');
      " 2>&1
    fi
  fi
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

  # Extract task and clear from env before running AI
  TASK_TEXT="${TASK_DESCRIPTION}"
  unset TASK_DESCRIPTION

  # Run pi in non-interactive (--print) mode.
  SYSTEM_ADDENDUM=""
  [ -f "/agent-data/implementation/AGENTS.md" ] && SYSTEM_ADDENDUM="$(cat /agent-data/implementation/AGENTS.md)"

  printf '%s' "${TASK_TEXT}" | \
    /app/node_modules/.bin/pi \
      --print \
      --no-session \
      --provider "${AGENT_PROVIDER:-github-copilot}" \
      --model "${AGENT_MODEL:-gpt-5-mini}" \
      ${SYSTEM_ADDENDUM:+--append-system-prompt "${SYSTEM_ADDENDUM}"}

  PI_EXIT=$?
  echo "[start] pi exited with code ${PI_EXIT}" >&2

  if [ $PI_EXIT -eq 0 ]; then
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
exec node /app/stdio-tcp-bridge.mjs /app/node_modules/.bin/pi-acp
