"""Dependency vulnerability gate for runtime (production) dependencies.

Policy
------
Block a push (and fail CI) when a **runtime** dependency has a **high** or
**critical** vulnerability **that has a fix available**. Everything else is
reported but doesn't block:

* low / moderate severity                   -> reported
* high / critical with *no fix released*    -> reported ("nothing to upgrade to yet")
* dev-only dependencies (test, lint, build) -> not audited; they never ship

Why "fixable" is the line: blocking on a vulnerability nobody can fix yet would
freeze all work without making anything safer. Once a fix exists, there's no
reason to ship the vulnerable version.

Unknown severity counts as high. If the severity can't be found, assuming
it's harmless would be the risky choice.

Sources
-------
* Frontend: ``npm audit --omit=dev --json`` in ``frontend/`` (GitHub Advisory DB).
* Backend:  ``pip-audit -r backend/requirements.txt -f json`` (PyPI/OSV advisories).
  pip-audit reports fix versions but not severity, so severity is looked up
  per advisory from the OSV API (https://osv.dev), preferring the GitHub
  advisory's rating (``database_specific.severity``).

Where it blocks, and where it only warns
---------------------------------------
* **Locally, on ``git push``** (the pre-push hook): blocks as described above,
  with the interactive override below.
* **In CI** (``--report-only``): never fails the pipeline. A vulnerability
  that's found but has no release to upgrade to would otherwise block every
  build until upstream ships a fix. Instead each high/critical finding becomes
  a ``WARNING`` in the log and a GitHub Actions warning annotation
  (``::warning::``) on the run summary, so it's visible on every PR without
  stopping work.

Override
--------
When blocking findings exist *and* the gate runs in an interactive terminal (a
developer running ``git push``), it asks for confirmation. Type ``override``
and a reason to push anyway. Each override is appended, with the user, time,
reason and findings, to ``.git/vuln-overrides.log``. Without a terminal (CI,
scripts, IDE push buttons) there's no prompt: blocking findings fail the run.

If an audit can't run at all (offline, registry down), the gate treats that
as blocking too, with the same override prompt. A gate that silently passes
when it can't check would give false confidence.

Usage::

    python scripts/check_vulns.py                 # blocks; prompts only in a terminal (pre-push)
    python scripts/check_vulns.py --no-input      # blocks; never prompts
    python scripts/check_vulns.py --report-only   # warns, never blocks (CI)

Exit codes: 0 = allowed (clean, overridden, or report-only), 1 = blocked.

This script uses only the standard library, so it runs with any Python 3.10+.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOCKING_SEVERITIES = frozenset({"high", "critical"})
OSV_URL = "https://api.osv.dev/v1/vulns/{id}"


@dataclass(frozen=True)
class Finding:
    """One vulnerable runtime package, normalised across npm and pip."""

    ecosystem: str  # "npm" or "pypi"
    package: str
    version: str
    advisory: str  # e.g. "GHSA-xxxx-xxxx-xxxx" or "PYSEC-2024-1"
    severity: str  # "low" | "moderate" | "high" | "critical" | "unknown"
    fix: str | None  # what to upgrade to, or None if no fix exists

    @property
    def blocking(self) -> bool:
        """High/critical (or unknown) severity *and* a fix is available."""
        return self.fix is not None and (self.severity in BLOCKING_SEVERITIES or self.severity == "unknown")

    def describe(self) -> str:
        fix = f"fix: {self.fix}" if self.fix else "no fix available yet"
        return f"[{self.severity.upper()}] {self.ecosystem}:{self.package}@{self.version} {self.advisory} ({fix})"


@dataclass(frozen=True)
class AuditError:
    """An audit that couldn't run - itself a reason to block (see module docs)."""

    ecosystem: str
    message: str


# ---------------------------------------------------------------------------
# npm
# ---------------------------------------------------------------------------


def parse_npm_audit(report: dict) -> list[Finding]:
    """Turn ``npm audit --json`` (report version 2) into findings.

    npm lists one entry per vulnerable package. ``fixAvailable`` is ``false``
    when no fix exists, or ``true`` / an object naming the upgrade when one does.

    >>> parse_npm_audit({"vulnerabilities": {"x": {"name": "x", "severity": "high",
    ...     "range": "<2", "fixAvailable": True, "via": [{"url": "https://github.com/advisories/GHSA-1"}]}}})[0].blocking
    True
    """
    findings: list[Finding] = []
    for name, vuln in report.get("vulnerabilities", {}).items():
        fix_available = vuln.get("fixAvailable", False)
        if isinstance(fix_available, dict):
            fix = f"{fix_available.get('name', name)}@{fix_available.get('version', '?')}"
        else:
            fix = "npm audit fix" if fix_available else None
        # `via` holds advisory objects, or names of other vulnerable packages
        # this one depends on (a transitive vulnerability).
        advisories = [v.get("url", "").rsplit("/", 1)[-1] for v in vuln.get("via", []) if isinstance(v, dict)]
        findings.append(
            Finding(
                ecosystem="npm",
                package=vuln.get("name", name),
                version=vuln.get("range", "?"),
                advisory=", ".join(a for a in advisories if a) or "via " + ", ".join(map(str, vuln.get("via", []))),
                severity=str(vuln.get("severity", "unknown")).lower(),
                fix=fix,
            )
        )
    return findings


def audit_npm(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> list[Finding] | AuditError:
    """Run npm audit on the frontend's production dependencies."""
    if not shutil.which("npm"):
        return AuditError("npm", "npm not found on PATH")
    proc = run(
        ["npm", "audit", "--omit=dev", "--json"],
        cwd=ROOT / "frontend",
        capture_output=True,
        text=True,
        check=False,
    )
    # npm audit exits 1 when it finds vulnerabilities; that's still a report.
    try:
        report = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return AuditError("npm", f"unreadable npm audit output: {proc.stderr.strip()[:300]}")
    if "error" in report:
        return AuditError("npm", str(report["error"].get("summary", report["error"]))[:300])
    return parse_npm_audit(report)


# ---------------------------------------------------------------------------
# pip
# ---------------------------------------------------------------------------


def osv_severity(ids: Iterable[str], fetch: Callable[[str], dict] | None = None) -> str:
    """Look up an advisory's severity on OSV, trying each id/alias in turn.

    GitHub advisories (GHSA-*) carry a plain rating in
    ``database_specific.severity`` (LOW / MODERATE / HIGH / CRITICAL), so they
    are tried first. Returns ``"unknown"`` if nothing usable is found.

    >>> osv_severity(["PYSEC-1", "GHSA-2"], fetch=lambda i: {"database_specific": {"severity": "HIGH"}} if i == "GHSA-2" else {})
    'high'
    """
    fetch = fetch or _fetch_osv
    ordered = sorted(set(ids), key=lambda i: (not i.startswith("GHSA-"), i))
    for advisory_id in ordered:
        try:
            data = fetch(advisory_id)
        except Exception:  # noqa: S112 - network trouble just means "try the next id"
            continue
        severity = str(data.get("database_specific", {}).get("severity", "")).lower()
        if severity in {"low", "moderate", "medium", "high", "critical"}:
            return "moderate" if severity == "medium" else severity
    return "unknown"


def _fetch_osv(advisory_id: str) -> dict:
    """GET one advisory from the OSV API (10 s timeout)."""
    with urllib.request.urlopen(OSV_URL.format(id=advisory_id), timeout=10) as response:  # noqa: S310 - fixed https URL
        return json.load(response)


def parse_pip_audit(report: dict, severity_of: Callable[[Iterable[str]], str] = osv_severity) -> list[Finding]:
    """Turn ``pip-audit -f json`` into findings, looking up each severity.

    >>> parse_pip_audit({"dependencies": [{"name": "x", "version": "1", "vulns": [
    ...     {"id": "PYSEC-1", "aliases": [], "fix_versions": []}]}]}, severity_of=lambda ids: "critical")[0].blocking
    False
    """
    findings: list[Finding] = []
    for dep in report.get("dependencies", []):
        for vuln in dep.get("vulns", []):
            ids = [vuln["id"], *vuln.get("aliases", [])]
            fixes = vuln.get("fix_versions") or []
            findings.append(
                Finding(
                    ecosystem="pypi",
                    package=dep["name"],
                    version=dep.get("version", "?"),
                    advisory=vuln["id"],
                    severity=severity_of(ids),
                    fix=f"{dep['name']}>={fixes[0]}" if fixes else None,
                )
            )
    return findings


def audit_pip(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> list[Finding] | AuditError:
    """Run pip-audit on the backend's runtime requirements only."""
    pip_audit = ROOT / "backend" / ".venv" / "bin" / "pip-audit"
    exe = str(pip_audit) if pip_audit.exists() else shutil.which("pip-audit")
    if not exe:
        return AuditError("pypi", "pip-audit not installed (pip install -r backend/requirements-dev.txt)")
    proc = run(
        [exe, "-r", str(ROOT / "backend" / "requirements.txt"), "-f", "json", "--progress-spinner", "off"],
        capture_output=True,
        text=True,
        check=False,
    )
    # pip-audit exits 1 when it finds vulnerabilities; that's still a report.
    try:
        report = json.loads(proc.stdout or "")
    except json.JSONDecodeError:
        return AuditError("pypi", f"pip-audit failed: {proc.stderr.strip()[-300:]}")
    return parse_pip_audit(report)


# ---------------------------------------------------------------------------
# Decision and override
# ---------------------------------------------------------------------------


def record_override(reason: str, blocking: list[Finding], errors: list[AuditError], log: Path | None = None) -> Path:
    """Append an override to the local audit trail and return the log path."""
    log = log or ROOT / ".git" / "vuln-overrides.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "time": datetime.now(timezone.utc).isoformat(),
        "user": getpass.getuser(),
        "reason": reason,
        "findings": [f.describe() for f in blocking],
        "audit_errors": [f"{e.ecosystem}: {e.message}" for e in errors],
    }
    with log.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")
    return log


def ask_override(prompt_input: Callable[[str], str]) -> str | None:
    """Ask for 'override' and a reason. Returns the reason, or None to stay blocked."""
    answer = prompt_input("Type 'override' to push anyway, or press Enter to cancel: ").strip().lower()
    if answer != "override":
        return None
    reason = prompt_input("Reason (recorded in .git/vuln-overrides.log): ").strip()
    return reason or None


def decide(
    findings: list[Finding],
    errors: list[AuditError],
    *,
    interactive: bool,
    prompt_input: Callable[[str], str] = input,
    out: Callable[[str], None] = print,
    log: Path | None = None,
) -> int:
    """Print the report and return the exit code (0 allowed, 1 blocked)."""
    blocking = [f for f in findings if f.blocking]
    for f in sorted(findings, key=lambda f: (not f.blocking, f.ecosystem, f.package)):
        out(("BLOCKING  " if f.blocking else "reported  ") + f.describe())
    for e in errors:
        out(f"BLOCKING  could not audit {e.ecosystem}: {e.message}")

    if not blocking and not errors:
        out(f"Vulnerability gate passed ({len(findings)} non-blocking finding(s)).")
        return 0

    out(
        f"\nVulnerability gate: {len(blocking)} fixable high/critical runtime finding(s)"
        f"{f' and {len(errors)} audit failure(s)' if errors else ''}. Upgrade, then push again."
    )
    if not interactive:
        out("Not running in a terminal, so it can't be overridden here.")
        return 1

    reason = ask_override(prompt_input)
    if reason is None:
        out("Push cancelled.")
        return 1
    path = record_override(reason, blocking, errors, log)
    out(f"Override recorded in {path}. Proceeding.")
    return 0


def report_only(findings: list[Finding], errors: list[AuditError], out: Callable[[str], None] = print) -> int:
    """CI mode: log every finding, warn loudly about high/critical ones, never block.

    Each warning is printed twice: once as a plain ``WARNING`` line for the
    log, and once as a GitHub Actions workflow command (``::warning
    title=...::message``), which GitHub shows as an annotation on the run and
    the pull request. Outside GitHub Actions the second line is just text.
    """
    serious = [f for f in findings if f.severity in BLOCKING_SEVERITIES or f.severity == "unknown"]
    for f in findings:
        if f in serious:
            continue
        out(f"info      {f.describe()}")
    for f in serious:
        if f.fix:
            detail = f"a fix is available ({f.fix}); the pre-push hook blocks this locally until it's upgraded"
        else:
            detail = "presumably there is not yet a fix; it will block pushes once a fixed version is released"
        message = f"{f.describe()} - {detail}"
        out(f"WARNING   {message}")
        out(f"::warning title=Vulnerable runtime dependency ({f.severity})::{message}")
    for e in errors:
        message = f"could not audit {e.ecosystem}: {e.message}"
        out(f"WARNING   {message}")
        out(f"::warning title=Vulnerability audit did not run::{message}")
    out(
        f"Vulnerability report: {len(serious)} high/critical, {len(findings) - len(serious)} lower, "
        f"{len(errors)} audit failure(s). Report-only mode: not blocking."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--no-input", action="store_true", help="never prompt for an override")
    parser.add_argument("--report-only", action="store_true", help="warn about findings but never block (CI)")
    args = parser.parse_args(argv)

    findings: list[Finding] = []
    errors: list[AuditError] = []
    for result in (audit_npm(), audit_pip()):
        if isinstance(result, AuditError):
            errors.append(result)
        else:
            findings.extend(result)

    if args.report_only:
        return report_only(findings, errors)

    # Git runs hooks with stdin attached to its own data, not the keyboard, so
    # the prompt reads from the terminal device directly when there is one.
    interactive = not args.no_input and not os.environ.get("CI") and _has_tty()
    return decide(findings, errors, interactive=interactive, prompt_input=_tty_input)


def _has_tty() -> bool:
    try:
        with open("/dev/tty"):
            return True
    except OSError:
        return False


def _tty_input(prompt: str) -> str:
    with open("/dev/tty", "r+", encoding="utf-8") as tty:
        tty.write(prompt)
        tty.flush()
        return tty.readline()


if __name__ == "__main__":
    sys.exit(main())
