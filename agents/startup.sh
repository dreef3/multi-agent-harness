#!/bin/sh
# Substitute env vars in all agent config files at startup
# This ensures MCP_TOKEN and other runtime env vars are expanded
for conf_dir in /root/.gemini /root/.config/opencode /root/.config/copilot /app; do
  if [ -d "$conf_dir" ]; then
    find "$conf_dir" -name "*.json" -not -path "*/node_modules/*" | while read -r f; do
      if grep -q '\${' "$f" 2>/dev/null; then
        envsubst < "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"
      fi
    done
  fi
done
exec "$@"
