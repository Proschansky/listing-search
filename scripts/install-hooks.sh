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
echo "Git hooks installed: pre-commit (lint + tests for what you changed), pre-push (everything + e2e)."
