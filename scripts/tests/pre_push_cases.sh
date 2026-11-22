#!/usr/bin/env bash
# Behaviour cases for .githooks/pre-push, run by test_hooks.py.
#
# Builds a throwaway repo with a fake `make ci` (it fails when a file named
# FAIL exists) and feeds the hook the same stdin git would. Each case checks
# whether the gate ran, the hook's exit code, and how many trees it recorded.
#
# Safety: strict mode stops at the first error, the repo is a fresh temp dir
# that's verified before anything runs, and GIT_DIR / GIT_WORK_TREE are pinned
# to it, so a mistake can never touch the real project.
set -euo pipefail

HOOK_SRC="$1"
T="$(mktemp -d "${TMPDIR:-/tmp}/prepush-test.XXXXXX")"
case "$(basename "$T")" in prepush-test.*) ;; *) echo "refusing: bad temp dir $T"; exit 1;; esac
# Resolve symlinks (macOS's temp dir is /var -> /private/var), so the check
# below compares the same real path git reports.
T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT

cd "$T"
export GIT_DIR="$T/.git" GIT_WORK_TREE="$T"
git init -q
[ "$(git rev-parse --show-toplevel)" = "$T" ] || { echo "refusing: not in temp repo"; exit 1; }
git config user.email test@example.com
git config user.name test
mkdir .githooks
cp "$HOOK_SRC" .githooks/pre-push
printf 'ci:\n\t@echo "[make ci ran]"; test ! -f FAIL\n' > Makefile
echo a > f && git add -A && git commit -qm one

Z=0000000000000000000000000000000000000000
records() { wc -l < "$GIT_DIR/checked-trees" | tr -d ' '; }
# Feed the hook a push line for <rev>; print whether the gate ran and the record count.
push() {
  local sha out code
  sha="$(git rev-parse "$1")"
  set +e
  out="$(echo "refs/heads/x $sha refs/heads/x $Z" | bash .githooks/pre-push 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
  code=$?
  set -e
  local ran=skipped; [[ "$out" == *"[make ci ran]"* ]] && ran=RAN
  echo "$ran exit=$code records=$(records)"
}
check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1: $3"; else echo "FAIL  $1: expected '$2', got '$3'"; fails=$((fails+1)); fi
}
fails=0

check "1 new commit, clean"             "RAN exit=0 records=1"     "$(push HEAD)"
check "2 same commit again"             "skipped exit=0 records=1" "$(push HEAD)"
git commit -q --amend -m "reworded"
check "3 only the message changed"      "skipped exit=0 records=1" "$(push HEAD)"
echo b > f
# The pushed commit's files already passed; edits on disk aren't being pushed.
check "4 uncommitted edit, commit already checked" "skipped exit=0 records=1" "$(push HEAD)"
git checkout -q -- f
echo c > g && git add g && git commit -qm two
echo d > h
check "5 untracked file present"        "RAN exit=0 records=1"     "$(push HEAD)"
rm h
check "6 same commit, now clean"        "RAN exit=0 records=2"     "$(push HEAD)"
git branch -q other HEAD~1
git checkout -q other && echo e > f && git commit -qam three && git checkout -q -
check "7 pushing a non-checked-out commit" "RAN exit=0 records=2"  "$(push other)"
check "8 delete-only push"              "exit=0" "exit=$(set +e; echo "(delete) $Z refs/heads/x abc" | bash .githooks/pre-push >/dev/null 2>&1; echo $?)"
echo f2 > f && touch FAIL && git add f && git commit -qm four
check "9 gate fails"                    "RAN exit=2 records=2"     "$(push HEAD)"

echo
[ "$fails" -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
