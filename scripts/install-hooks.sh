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
# check has passed. Keepalives every 30 s stop that.
#
# Written only for this repo, and only if no SSH command is configured at
# any level. The check reads the effective setting (no --local), because a
# global or included core.sshCommand (one that picks an identity file, or a
# wrapper such as a VPN or password-manager tool) would otherwise be
# silently overridden here and break authentication for this clone. In that
# case we leave it alone and say how to add the keepalive to it.
KEEPALIVE="-o ServerAliveInterval=30 -o ServerAliveCountMax=20"
current="$(git config --get core.sshCommand || true)"
if [ -z "$current" ]; then
  git config --local core.sshCommand "ssh $KEEPALIVE"
elif [ "$current" != "ssh $KEEPALIVE" ]; then
  # Someone else's command (ours, from an earlier run, is left as is quietly).
  echo "Note: core.sshCommand is already set ($current), so keepalives were not added."
  echo "      If long pushes drop with 'the remote end hung up', add to your SSH command: $KEEPALIVE"
fi

echo "Git hooks installed: pre-commit (lint + tests for what you changed), pre-push (everything + e2e)."
