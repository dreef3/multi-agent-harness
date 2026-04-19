#!/bin/sh
# Wrapper used as PI_ACP_PI_COMMAND for planning agent sessions.
#
# pi-acp calls this script in place of the real pi binary.
# We load harness-planning-tools.mjs so that write_planning_document and other
# harness tools are registered directly via pi.registerTool() — no MCP metadata
# cache required, so it works on first-run CI where ports are randomized.
# We also inject the planning AGENTS.md as an appended system prompt.
#
# Set in start.sh via: export PI_ACP_PI_COMMAND=/app/pi-planning-wrapper.sh

PLANNING_PROMPT=""
[ -f "/agent-data/planning/AGENTS.md" ] && PLANNING_PROMPT="$(cat /agent-data/planning/AGENTS.md)"

exec /app/node_modules/.bin/pi \
  --extension /app/harness-planning-tools.mjs \
  ${PLANNING_PROMPT:+--append-system-prompt "${PLANNING_PROMPT}"} \
  "$@"
