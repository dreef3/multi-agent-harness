#!/bin/sh
# Exchange COPILOT_GITHUB_TOKEN for a Copilot session token and write it to
# pi's auth.json so that pi can make authenticated Copilot API calls.
# (The Copilot API requires a session token, not a raw GitHub token.)
#
# Pi will automatically refresh the session token using the stored refresh
# token (COPILOT_GITHUB_TOKEN) when it expires.

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
      -H "Copilot-Integration-Id: vscode-chat" 2>/dev/null) || HTTP_CODE=0

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
            process.stderr.write('[start] Copilot auth initialized\n');
          } else {
            process.stderr.write('[start] Copilot token response missing fields\n');
          }
        } catch (e) {
          process.stderr.write('[start] Copilot auth init error: ' + e.message + '\n');
        }
        try { require('fs').unlinkSync(process.env.RESP_FILE); } catch {}
      " 2>&1
    else
      echo "[start] Failed to get Copilot session token (HTTP ${HTTP_CODE})" >&2
      rm -f "${RESP_FILE}"
    fi
  fi
fi

exec node /app/stdio-tcp-bridge.mjs npx pi-acp
