#!/bin/sh
# Wrapper used as PI_ACP_PI_COMMAND for planning agent sessions.
#
# pi-acp calls this script in place of the real pi binary, passing its own
# arguments ($@). We prepend the planning extension (write_planning_document)
# and the planning AGENTS.md as an appended system prompt, then delegate to
# the actual pi binary.
#
# Set in start.sh via: export PI_ACP_PI_COMMAND=/app/pi-planning-wrapper.sh
#
# PLANNING_SYSTEM_PROMPT — if set, used instead of /agent-data/planning/AGENTS.md.
#   Useful for tests that need a simpler system prompt without the multi-phase
#   brainstorming workflow. Leave unset in production.

if [ -n "${PLANNING_SYSTEM_PROMPT}" ]; then
  PLANNING_PROMPT="${PLANNING_SYSTEM_PROMPT}"
else
  PLANNING_PROMPT=""
  [ -f "/agent-data/planning/AGENTS.md" ] && PLANNING_PROMPT="$(cat /agent-data/planning/AGENTS.md)"
fi

if [ -n "${PLANNING_PROMPT}" ]; then
  exec /app/node_modules/.bin/pi \
    --extension /app/harness-planning-tools.mjs \
    --append-system-prompt "${PLANNING_PROMPT}" \
    "$@"
else
  exec /app/node_modules/.bin/pi \
    --extension /app/harness-planning-tools.mjs \
    "$@"
fi
