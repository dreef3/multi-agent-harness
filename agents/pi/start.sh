#!/bin/sh
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

exec node /app/stdio-tcp-bridge.mjs npx pi-acp
