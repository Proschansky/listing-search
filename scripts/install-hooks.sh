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
# Written only for this repo, and only if you haven't chosen an SSH command
# yourself in any of the three ways git supports. Git picks, in this order:
#   1. the GIT_SSH_COMMAND environment variable
#   2. core.sshCommand in git config (what this script writes)
#   3. the GIT_SSH environment variable
# GIT_SSH ranks below config, so writing core.sshCommand would silently
# override a wrapper chosen through GIT_SSH and could break authentication.
# GIT_SSH_COMMAND would win anyway, but if you've set it we leave config
# alone too. For core.sshCommand we read the effective value (no --local),
# so a global or included setting (an identity file, or a wrapper such as a
# VPN or password-manager tool) counts as well. In every skip case we print
# how to add the keepalive to your own command.
#
# Limitation: only variables set when this script runs are visible. If you
# export GIT_SSH in a shell profile but run `make hooks` from somewhere that
# doesn't load it (an IDE, say), it can't be seen; the README explains how
# to remove the setting.
KEEPALIVE="-o ServerAliveInterval=30 -o ServerAliveCountMax=20"
current="$(git config --get core.sshCommand || true)"
skip_reason=""
if [ -n "${GIT_SSH_COMMAND:-}" ]; then
  skip_reason="GIT_SSH_COMMAND is set ($GIT_SSH_COMMAND)"
elif [ -n "${GIT_SSH:-}" ]; then
  skip_reason="GIT_SSH is set ($GIT_SSH)"
elif [ -n "$current" ] && [ "$current" != "ssh $KEEPALIVE" ]; then
  # Someone else's command (ours, from an earlier run, is left as is quietly).
  skip_reason="core.sshCommand is already set ($current)"
fi

if [ -n "$skip_reason" ]; then
  # If an earlier run wrote our value here, take it back out, or it would
  # keep overriding the GIT_SSH wrapper you've since set.
  if [ "$(git config --local --get core.sshCommand || true)" = "ssh $KEEPALIVE" ]; then
    git config --local --unset core.sshCommand
    echo "Removed the keepalive core.sshCommand an earlier 'make hooks' added to this repo."
  fi
  echo "Note: $skip_reason, so keepalives were not added."
  echo "      If long pushes drop with 'the remote end hung up', add to your SSH command: $KEEPALIVE"
elif [ -z "$current" ]; then
  git config --local core.sshCommand "ssh $KEEPALIVE"
fi

echo "Git hooks installed: pre-commit (lint + tests for what you changed), pre-push (everything + e2e)."
