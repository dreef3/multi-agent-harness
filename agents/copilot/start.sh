#!/bin/sh
# pi-acp uses AGENT_PROVIDER=github-copilot; harness passes AGENT_PROVIDER=copilot — remap it.
if [ "${AGENT_PROVIDER:-}" = "copilot" ]; then
  export AGENT_PROVIDER=github-copilot
fi
exec node /app/stdio-tcp-bridge.mjs npx pi-acp
