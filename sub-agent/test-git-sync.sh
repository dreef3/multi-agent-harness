#!/usr/bin/env bash
# Integration test: verifies git sync merges base branch advances into feature branch.
set -euo pipefail

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# 1. Create a bare remote
git init --bare "$TMPDIR/remote.git" -q

# 2. Clone it and set up initial commit on main
git clone "$TMPDIR/remote.git" "$TMPDIR/repo" -q
cd "$TMPDIR/repo"
git config user.email "test@test.com"
git config user.name "Test"
echo "v1" > file.txt && git add . && git commit -m "base v1" -q
git push origin main -q

# 3. Create feature branch off main
git checkout -b feature/test -q
echo "feat" > feat.txt && git add . && git commit -m "feat commit" -q
git push origin feature/test -q

# 4. Advance main with a new commit (simulating another PR merged)
git checkout main -q
echo "v2" > file.txt && git add . && git commit -m "base v2" -q
git push origin main -q

# 5. Simulate sub-agent: fresh clone, checkout feature branch, fetch+merge base
git clone "$TMPDIR/remote.git" "$TMPDIR/workspace" -q
cd "$TMPDIR/workspace"
git checkout feature/test -q
# This is what runner.mjs does:
git fetch "$TMPDIR/remote.git" main
git merge --no-edit FETCH_HEAD -q

# 6. Assert both commits are reachable
git log --oneline | grep -q "base v2" && echo "PASS: base v2 merged into feature branch" || { echo "FAIL: base v2 not found"; exit 1; }
git log --oneline | grep -q "feat commit" && echo "PASS: feature commit preserved" || { echo "FAIL: feat commit missing"; exit 1; }

echo "All tests passed."
