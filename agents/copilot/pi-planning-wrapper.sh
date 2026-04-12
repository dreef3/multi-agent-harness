#!/bin/sh
# Wrapper used as PI_ACP_PI_COMMAND for planning agent sessions.
#
# pi-acp calls this script in place of the real pi binary.
# We load pi-mcp-adapter so that all harness MCP tools (write_planning_document,
# dispatch_tasks, etc.) are available to the LLM as native pi tools via the
# MCP server configured in ~/.pi/agent/mcp.json (written by start.sh).
# We also inject the planning AGENTS.md as an appended system prompt.
#
# Set in start.sh via: export PI_ACP_PI_COMMAND=/app/pi-planning-wrapper.sh

PLANNING_PROMPT=""
[ -f "/agent-data/planning/AGENTS.md" ] && PLANNING_PROMPT="$(cat /agent-data/planning/AGENTS.md)"

exec /app/node_modules/.bin/pi \
  --extension /app/node_modules/pi-mcp-adapter/index.ts \
  ${PLANNING_PROMPT:+--append-system-prompt "${PLANNING_PROMPT}"} \
  "$@"
