#!/usr/bin/env bash
# Rebuild better-sqlite3 native bindings.
# Required when bun's cached version has no prebuilt binary for the current Node.js ABI.
set -e

SQLITE_DIR=$(ls -d node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1)

if [ -z "$SQLITE_DIR" ]; then
  echo "better-sqlite3 not found in bun cache — skipping rebuild" >&2
  exit 0
fi

if [ -f "$SQLITE_DIR/build/Release/better_sqlite3.node" ]; then
  echo "better-sqlite3 native binding already built — skipping" >&2
  exit 0
fi

echo "Building better-sqlite3 native binding in $SQLITE_DIR ..." >&2
cd "$SQLITE_DIR"
CXXFLAGS="-std=c++20" node-gyp rebuild
echo "Done." >&2
