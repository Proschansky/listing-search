# One entry point for every quality check, used by developers, the git hooks
# (.githooks/) and CI (.github/workflows/). If a check changes, change it here
# and all three stay in step.
#
#   make setup      install everything (backend venv, frontend packages, git hooks)
#   make lint       linters + formatters + type checks, both halves
#   make test       unit/component/a11y tests with coverage gates (>= 95%)
#   make e2e        Playwright end-to-end tests (starts both servers itself)
#   make check      lint + test            <- the pre-commit hook runs this per half
#   make ci         audit + check + e2e    <- the pre-push hook and CI run this
#   make audit      dependency vulnerability gate (pre-push blocks on it; CI
#                   runs it with --report-only, so it only warns there)
#   make openapi    regenerate backend/openapi.json after an API change
#
# Each half has its own targets (lint-backend, test-frontend, ...), so the
# pre-commit hook can skip the half you didn't touch.

PY      := backend/.venv/bin
# Newest Python 3.10+ available (plain python3 may be an older system one).
PYTHON  ?= $(shell for p in python3.13 python3.12 python3.11 python3.10 python3; do command -v $$p >/dev/null 2>&1 && $$p -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null && echo $$p && break; done)

.PHONY: setup hooks lint test check e2e ci audit openapi test-scripts \
        lint-backend lint-frontend test-backend test-frontend

setup: hooks
	@test -x $(PY)/python || $(PYTHON) -m venv backend/.venv
	$(PY)/pip install --quiet --upgrade pip
	$(PY)/pip install --quiet -r backend/requirements-dev.txt
	cd frontend && npm install --no-fund --no-audit

hooks:
	@bash scripts/install-hooks.sh

# --- Backend ---------------------------------------------------------------
lint-backend:
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
	$(PY)/ruff check scripts && $(PY)/ruff format --check scripts

test-backend:
	cd backend && .venv/bin/pytest --cov --cov-report=term-missing

# --- Frontend --------------------------------------------------------------
lint-frontend:
	cd frontend && npm run --silent lint && npm run --silent format:check && npm run --silent typecheck

test-frontend:
	cd frontend && npm run --silent test:coverage

# --- Repo scripts (the vulnerability gate) ----------------------------------
test-scripts:
	$(PY)/pytest scripts/tests --doctest-modules scripts/check_vulns.py \
	  --cov=check_vulns --cov-config=/dev/null --cov-fail-under=95 -q -p no:cacheprovider

# Blocks fixable high/critical vulnerabilities in runtime dependencies.
# Prompts for an override only when run from a terminal (see the script).
audit:
	$(PY)/python scripts/check_vulns.py

# --- Combined --------------------------------------------------------------
lint: lint-backend lint-frontend
test: test-backend test-frontend test-scripts
check: lint test

e2e:
	cd frontend && npm run --silent test:e2e

ci: audit check e2e

openapi:
	cd backend && .venv/bin/python -m scripts.export_openapi
