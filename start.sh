#!/usr/bin/env bash
# Start the whole app with one command:   bash start.sh
#
# 1. Checks that Python (3.10+) and Node (20.19+ or 22.12+) are new enough.
# 2. First run only: creates backend/.venv and installs Python packages
#    (runtime + dev tools), and runs `npm install` for the frontend.
# 3. Starts the API on http://localhost:8000 in the background, waits until
#    it answers, then starts the UI on http://localhost:5173.
# 4. Ctrl+C stops both.
#
# Written for the bash that ships with macOS (3.2), so no newer bash features.

set -euo pipefail

# Always run from the folder this script lives in, wherever it's called from.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. Check tool versions -------------------------------------------------

# Use the newest Python 3.10+ on the PATH. Plain `python3` can be an old
# system Python while a newer one is installed as e.g. `python3.12`.
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 \
     && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON="$candidate"; break
  fi
done
[ -n "$PYTHON" ] || die "Python 3.10+ not found (python3 is $(python3 -V 2>&1 | cut -d' ' -f2 || echo missing)). Install one, e.g. 'brew install python@3.12' or 'pyenv install 3.12'."

command -v node >/dev/null || die "node not found. Install Node 22 (e.g. 'nvm install 22')."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' \
  || die "Node $(node -v) is too old for Vite; use 20.19+ or 22.12+ (e.g. 'nvm install 22 && nvm use 22')."

# --- 2. One-time setup ------------------------------------------------------

if [ ! -x backend/.venv/bin/uvicorn ]; then
  say "First run: creating Python virtual environment and installing packages"
  "$PYTHON" -m venv backend/.venv
  backend/.venv/bin/pip install --quiet --upgrade pip
  # The dev requirements include the runtime ones plus pytest, ruff and mypy,
  # so the tests and git hooks work straight away.
  backend/.venv/bin/pip install --quiet -r backend/requirements-dev.txt
fi

if [ ! -d frontend/node_modules ]; then
  say "First run: installing frontend packages"
  (cd frontend && npm install --no-fund --no-audit)
fi

# --- 3. Start the servers ---------------------------------------------------

# Refuse to start if something is already using one of the ports, rather
# than failing halfway with a confusing error.
for port in 8000 5173; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port $port is already in use. Stop whatever is running there (maybe an earlier run of this script) and try again."
  fi
done

say "Starting API on http://localhost:8000"
(cd backend && exec .venv/bin/uvicorn app.main:app --reload --port 8000) &
API_PID=$!

# Stop the API when this script exits for any reason (Ctrl+C included).
cleanup() { kill "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait up to ~15 seconds for the API's readiness probe (data loaded and
# searchable). A 503 means it started but the data didn't load; see its log.
for _ in $(seq 1 30); do
  if curl -fs http://localhost:8000/api/v1/health/ready >/dev/null 2>&1; then break; fi
  kill -0 "$API_PID" 2>/dev/null || die "The API failed to start; see the messages above."
  sleep 0.5
done
curl -fs http://localhost:8000/api/v1/health/ready >/dev/null 2>&1 \
  || die "The API isn't ready on port 8000. Check its log above (and http://localhost:8000/api/v1/health/ready)."

say "Starting UI on http://localhost:5173  (Ctrl+C stops both)"
cd frontend
npm run dev -- --port 5173 --strictPort
