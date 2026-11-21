#!/usr/bin/env bash
# Point git at the versioned hooks in .githooks/ (instead of the untracked
# .git/hooks/), so every clone runs the same checks. Run once per clone;
# `make setup` does it for you.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repository yet - run 'git init', then 'make hooks'." >&2
  exit 0
fi

chmod +x .githooks/*
git config core.hooksPath .githooks

# Keep SSH pushes alive while the pre-push hook runs. Git opens the
# connection to GitHub *before* running the hook and sends the commits
# after it, and the full gate takes a few minutes, long enough for GitHub to
# drop an idle connection ("the remote end hung up unexpectedly") after every
# check has passed. Keepalives every 30 s stop that. Set only for this repo,
# and only if you haven't configured your own SSH command for it.
if [ -z "$(git config --local --get core.sshCommand || true)" ]; then
  git config --local core.sshCommand "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20"
fi

echo "Git hooks installed: pre-commit (lint + tests for what you changed), pre-push (everything + e2e)."
