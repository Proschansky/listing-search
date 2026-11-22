#!/usr/bin/env bash
# Behaviour cases for .githooks/pre-push and .githooks/pre-commit, run by
# test_hooks.py.
#
# Builds a throwaway repo with a fake Makefile and feeds the hooks the same
# input git would. In the fake Makefile, `audit` prints "[audit]", `check`
# prints "[gate]" (and fails when a file named FAIL exists), `e2e` passes,
# and the lint targets fail, so any attempt to lint is visible. Each case
# checks whether the audit ran, whether the gate ran, the exit code, and how
# many trees the hook recorded as checked.
#
# Safety: strict mode stops at the first error, the repo is a fresh temp dir
# that's verified before anything runs, and GIT_DIR / GIT_WORK_TREE are pinned
# to it, so a mistake can never touch the real project.
set -euo pipefail

HOOKS="$(cd "$(dirname "$1")" && pwd)"
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
cp "$HOOKS/pre-push" "$HOOKS/pre-commit" .githooks/
cat > Makefile <<'MAKE'
audit:
	@echo "[audit]"
check:
	@echo "[gate]"; test ! -f FAIL
e2e:
	@true
lint-backend lint-frontend:
	@echo "[lint]"; false
MAKE
echo a > f && git add -A && git commit -qm one

Z=0000000000000000000000000000000000000000
records() { wc -l < "$GIT_DIR/checked-trees" | tr -d ' '; }
# Feed pre-push one ref line; summarise what happened.
run_push() { # <local sha> <remote sha>
  local out code audit gate
  set +e
  out="$(echo "refs/heads/x $1 refs/heads/x $2" | bash .githooks/pre-push 2>&1)"
  code=$?
  set -e
  audit=no; [[ "$out" == *"[audit]"* ]] && audit=yes
  gate=skipped; [[ "$out" == *"[gate]"* ]] && gate=RAN
  echo "audit=$audit gate=$gate exit=$code records=$(records)"
}
push() { run_push "$(git rev-parse "$1")" "$Z"; }           # push <rev> as a new branch
precommit() { set +e; bash .githooks/pre-commit >/dev/null 2>&1; echo "exit=$?"; set -e; }
check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1: $3"; else echo "FAIL  $1: expected '$2', got '$3'"; fails=$((fails+1)); fi
}
fails=0

# --- Running the gate once per version of the code ---------------------------
check "1 new commit, clean"                "audit=yes gate=RAN exit=0 records=1"     "$(push HEAD)"
check "2 same commit again (audit reruns)" "audit=yes gate=skipped exit=0 records=1" "$(push HEAD)"
git commit -q --amend -m "reworded"
check "3 only the message changed"         "audit=yes gate=skipped exit=0 records=1" "$(push HEAD)"
echo b > f
check "4 uncommitted edit, commit checked" "audit=yes gate=skipped exit=0 records=1" "$(push HEAD)"
git checkout -q -- f
echo c > g && git add g && git commit -qm two
echo d > h
check "5 untracked file present"           "audit=yes gate=RAN exit=0 records=1"     "$(push HEAD)"
rm h
check "6 same commit, now clean"           "audit=yes gate=RAN exit=0 records=2"     "$(push HEAD)"
git branch -q other HEAD~1
git checkout -q other && echo e > f && git commit -qam three && git checkout -q -
check "7 pushing a non-checked-out commit" "audit=yes gate=RAN exit=0 records=2"     "$(push other)"
check "8 delete-only push (no audit)"      "audit=no gate=skipped exit=0 records=2"  "$(run_push "$Z" "abc")"
echo f2 > f && touch FAIL && git add f && git commit -qm four
check "9 gate fails"                       "audit=yes gate=RAN exit=2 records=2"     "$(push HEAD)"
rm FAIL

# --- Documentation-only pushes skip the gate, never the audit ---------------
git update-ref refs/remotes/origin/main HEAD   # pretend main is here
echo "# docs" > README.md && mkdir -p docs && echo x > docs/guide.md
git add README.md docs && git commit -qm docs
check "10 docs-only, new branch"           "audit=yes gate=skipped exit=0 records=2" "$(push HEAD)"
echo code > app.py && echo more >> README.md && git add -A && git commit -qm mixed
check "11 docs plus code"                  "audit=yes gate=RAN exit=0 records=3"     "$(push HEAD)"
remote_sha="$(git rev-parse HEAD)"
echo "even more" >> README.md && git commit -qam docs2
check "12 docs-only update, existing branch" "audit=yes gate=skipped exit=0 records=3" "$(run_push "$(git rev-parse HEAD)" "$remote_sha")"
git mv app.py docs/app-notes.md && git commit -qm "move code into docs"
check "13 code renamed into docs/"         "audit=yes gate=RAN exit=0 records=4"     "$(run_push "$(git rev-parse HEAD)" "$remote_sha")"
unknown=1111111111111111111111111111111111111111   # a remote commit we never fetched
echo "docs again" >> README.md && git commit -qam docs3
check "14 remote commit not fetched"       "audit=yes gate=RAN exit=0 records=5"     "$(run_push "$(git rev-parse HEAD)" "$unknown")"

# --- Pre-commit: documentation-only commits skip linting --------------------
echo doc >> README.md && git add README.md
check "15 pre-commit, docs only"           "exit=0" "$(precommit)"
git reset -q
echo "x = 1" > lib.py && git add lib.py && git commit -qm lib
echo doc >> README.md && git add README.md && git rm -q lib.py
check "16 pre-commit, code file deleted"   "exit=2" "$(precommit)"
git reset -q --hard
echo "y = 2" > mod.py && git add mod.py && git commit -qm mod
git mv mod.py docs/mod.md
check "17 pre-commit, code renamed into docs" "exit=2" "$(precommit)"
git reset -q --hard
echo "z = 3" >> app2.py && git add app2.py
check "18 pre-commit, code staged (lints)" "exit=2" "$(precommit)"

echo
[ "$fails" -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
