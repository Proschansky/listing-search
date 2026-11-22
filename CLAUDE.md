# Listing Search — working rules

Monorepo: `backend/` (FastAPI, Python 3.10+) and `frontend/` (React 19 + TypeScript + Vite). Full docs in README.md.

## Requirements that apply to every change

- **It should look and behave like an enterprise product**, while running on the bundled sample data (`backend/data/sample_listings.json`). Live data sources (SimplyRETS, Kaggle) come last, behind `ListingRepository`, and must stay optional.
- **Style matters.** The UI should look polished and modern in light and dark themes, at phone and desktop widths. Styles are SCSS Modules: one `Component.module.scss` beside each component, shared primitives in `src/styles/ui.module.scss`, and only `src/styles/global.scss` is global. Colours come from the token maps in `src/styles/_tokens.scss` (as `var(--token)`), never raw values; reuse the mixins in `_mixins.scss` (focus ring, inputs, breakpoints).
- **Accessibility is required**, not optional: keyboard-reachable, labelled controls, visible focus, WCAG 2.x AA. The axe suites must pass.
- **Tests for everything:** every frontend `.ts`/`.tsx` module gets a `*.test.ts(x)` beside it; every backend module gets `backend/tests/test_*.py`. New user flows get a Playwright spec in `frontend/e2e/`.
- **Coverage ≥ 95%** on both halves (statements, branches, functions, lines). Never lower a threshold to land a change.
- **Detailed comments:** each file opens with what it does and why. Explain *why* in comments, not just *what*, and number the steps in longer functions. Use TSDoc in TypeScript and docstrings in Python.
- **Docs stay current.** A new feature, setting, endpoint or command gets documented in the same change. `README.md` is the short overview for product managers, engineering managers and prospective users; reference detail goes in `docs/` (`api.md`, `ranking.md`, `engineering.md`). Write docs in plain English: lead with the point, keep sentences short, explain a technical term the first time it appears, and avoid AI-sounding filler (staged openers, forced lists of three, inflated claims, decorative bold).

## Commands

```bash
make setup    # install everything + git hooks
make check    # lint + tests with coverage gates (no e2e)
make e2e      # Playwright suite
make ci       # audit + check + e2e: the pre-push gate (CI runs the same checks as separate jobs)
# Docs-only changes (Markdown, docs/) skip lint and tests automatically; the vulnerability check always runs on push.
make openapi  # regenerate backend/openapi.json after any API change
```

## Conventions

- API: everything under `/api/v1`; errors use the envelope in `backend/app/errors.py`; validation lives only in `validation.py` (the UI never duplicates rules).
- Settings: add to `backend/app/config.py` (typed, `LISTING_` prefix, safe default) and the README's configuration table.
- Frontend network calls go only through `frontend/src/api.ts`.
- PRs follow `.github/pull_request_template.md`: brief TL;DR, files-changed table, checklists, QA Validation with steps for the reviewer.
- PR evidence: run `npm run pr:evidence:publish` (in `frontend/`) when a PR changes e2e specs. It attaches screenshots and network captures for the changed spec files only, and does nothing if no spec changed. Add `evidence.capture('…')` at key moments in new specs.
- Don't commit `.env` files or secrets.
- Dependency vulnerabilities: the pre-push hook blocks fixable high/critical findings in runtime deps (interactive override, logged); CI only warns. Never bypass the gate with `--no-verify` to land a vulnerable upgrade.
