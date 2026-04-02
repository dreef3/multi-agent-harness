#!/bin/sh
# Rebuild better-sqlite3 native bindings.
# Required when bun's cached version has no prebuilt binary for the current Node.js ABI.
# Uses globally-installed node-gyp (npm install -g node-gyp in the Dockerfile).
set -e

# Try bun's nested cache path first, then fall back to the flat node_modules path
SQLITE_DIR=$(ls -d node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1)

if [ -z "$SQLITE_DIR" ] && [ -d "node_modules/better-sqlite3" ]; then
  SQLITE_DIR="node_modules/better-sqlite3"
fi

if [ -z "$SQLITE_DIR" ]; then
  echo "better-sqlite3 not found — skipping rebuild" >&2
  exit 0
fi

if [ -f "$SQLITE_DIR/build/Release/better_sqlite3.node" ]; then
  echo "better-sqlite3 native binding already built — skipping" >&2
  exit 0
fi

# node-gyp v12+ gyp scripts use Python 3.8+ syntax (walrus operator).
# UBI8 ships Python 3.6 as the default python3; find a 3.8+ interpreter.
for PYBIN in python3.11 python3.10 python3.9 python3.8 python3; do
  if command -v "$PYBIN" > /dev/null 2>&1; then
    PYVER=$("$PYBIN" -c "import sys; print(sys.version_info >= (3, 8))" 2>/dev/null || echo False)
    if [ "$PYVER" = "True" ]; then
      export PYTHON="$PYBIN"
      echo "Using $PYBIN for node-gyp" >&2
      break
    fi
  fi
done

echo "Building better-sqlite3 native binding in $SQLITE_DIR ..." >&2
cd "$SQLITE_DIR"

# binding.gyp hardcodes -std=c++20, which is not recognized by gcc < 10 (e.g. UBI8 gcc 8).
# Replace with the equivalent pre-standard alias -std=c++2a, which is accepted by all
# relevant gcc versions (gcc 8+) and is identical to c++20 in gcc 10+.
sed -i 's/-std=c++20/-std=c++2a/g' binding.gyp 2>/dev/null || true

node-gyp rebuild
echo "Done." >&2
