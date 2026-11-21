"""Tests for the dependency vulnerability gate (scripts/check_vulns.py)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import check_vulns as cv


def finding(severity="high", fix="pkg@2.0.0", **kw):
    base = dict(ecosystem="npm", package="pkg", version="1.0.0", advisory="GHSA-x", severity=severity, fix=fix)
    base.update(kw)
    return cv.Finding(**base)


# --- Policy ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("severity", "fix", "blocking"),
    [
        ("critical", "pkg@2", True),
        ("high", "pkg@2", True),
        ("unknown", "pkg@2", True),  # unknown severity is treated as high
        ("moderate", "pkg@2", False),
        ("low", "pkg@2", False),
        ("critical", None, False),  # nothing to upgrade to yet
        ("high", None, False),
    ],
)
def test_blocks_only_fixable_high_and_critical(severity, fix, blocking):
    assert finding(severity, fix).blocking is blocking


def test_describe_mentions_severity_package_and_fix():
    assert finding().describe() == "[HIGH] npm:pkg@1.0.0 GHSA-x (fix: pkg@2.0.0)"
    assert "no fix available yet" in finding(fix=None).describe()


# --- npm parsing ---------------------------------------------------------------


def test_parse_npm_audit_reads_fix_objects_booleans_and_transitive_entries():
    report = {
        "vulnerabilities": {
            "a": {
                "name": "a",
                "severity": "critical",
                "range": "<1.2",
                "fixAvailable": {"name": "a", "version": "1.2.0"},
                "via": [{"url": "https://github.com/advisories/GHSA-aaaa"}],
            },
            "b": {"name": "b", "severity": "high", "range": "*", "fixAvailable": False, "via": ["a"]},
            "c": {"name": "c", "severity": "moderate", "range": "<3", "fixAvailable": True, "via": []},
        }
    }
    a, b, c = cv.parse_npm_audit(report)
    assert (a.fix, a.advisory, a.blocking) == ("a@1.2.0", "GHSA-aaaa", True)
    assert (b.fix, b.advisory, b.blocking) == (None, "via a", False)
    assert (c.fix, c.blocking) == ("npm audit fix", False)


def test_parse_npm_audit_handles_a_clean_report():
    assert cv.parse_npm_audit({"vulnerabilities": {}}) == []


# --- pip parsing and severity lookup ----------------------------------------------


def test_parse_pip_audit_uses_first_fix_and_looks_up_severity():
    seen = []

    def severity_of(ids):
        seen.append(list(ids))
        return "critical"

    report = {
        "dependencies": [
            {"name": "ok", "version": "1", "vulns": []},
            {
                "name": "bad",
                "version": "1.0",
                "vulns": [{"id": "PYSEC-1", "aliases": ["GHSA-1"], "fix_versions": ["1.1", "2.0"]}],
            },
        ]
    }
    (f,) = cv.parse_pip_audit(report, severity_of=severity_of)
    assert (f.ecosystem, f.package, f.fix, f.severity, f.blocking) == ("pypi", "bad", "bad>=1.1", "critical", True)
    assert seen == [["PYSEC-1", "GHSA-1"]]


def test_osv_severity_prefers_ghsa_and_normalises_medium():
    calls = []

    def fetch(advisory_id):
        calls.append(advisory_id)
        return {"database_specific": {"severity": "MEDIUM"}}

    assert cv.osv_severity(["PYSEC-9", "GHSA-9"], fetch=fetch) == "moderate"
    assert calls == ["GHSA-9"]


def test_osv_severity_skips_failing_lookups_and_falls_back_to_unknown():
    def fetch(advisory_id):
        if advisory_id == "GHSA-1":
            raise OSError("offline")
        return {}

    assert cv.osv_severity(["GHSA-1", "PYSEC-1"], fetch=fetch) == "unknown"


# --- Running the audits ------------------------------------------------------------


def fake_run(stdout="", stderr=""):
    def run(*_args, **_kwargs):
        return subprocess.CompletedProcess([], 1, stdout=stdout, stderr=stderr)

    return run


def test_audit_npm_parses_output(monkeypatch):
    monkeypatch.setattr(cv.shutil, "which", lambda _: "/usr/bin/npm")
    out = json.dumps({"vulnerabilities": {"x": {"name": "x", "severity": "low", "fixAvailable": False, "via": []}}})
    assert cv.audit_npm(run=fake_run(out))[0].package == "x"


@pytest.mark.parametrize("stdout", ["not json", json.dumps({"error": {"summary": "registry down"}})])
def test_audit_npm_reports_failures(monkeypatch, stdout):
    monkeypatch.setattr(cv.shutil, "which", lambda _: "/usr/bin/npm")
    assert isinstance(cv.audit_npm(run=fake_run(stdout, "boom")), cv.AuditError)


def test_audit_npm_without_npm(monkeypatch):
    monkeypatch.setattr(cv.shutil, "which", lambda _: None)
    assert cv.audit_npm().message == "npm not found on PATH"


def test_audit_pip_parses_output(monkeypatch, tmp_path):
    monkeypatch.setattr(cv, "ROOT", tmp_path)
    monkeypatch.setattr(cv.shutil, "which", lambda _: "/usr/bin/pip-audit")
    monkeypatch.setattr(cv, "osv_severity", lambda ids, fetch=None: "low")
    out = json.dumps({"dependencies": [{"name": "x", "version": "1", "vulns": [{"id": "P-1", "fix_versions": []}]}]})
    result = cv.audit_pip(run=fake_run(out))
    assert result[0].package == "x"


def test_audit_pip_reports_failures(monkeypatch, tmp_path):
    monkeypatch.setattr(cv, "ROOT", tmp_path)
    monkeypatch.setattr(cv.shutil, "which", lambda _: "/usr/bin/pip-audit")
    assert "pip-audit failed" in cv.audit_pip(run=fake_run("", "resolution error")).message


def test_audit_pip_without_pip_audit(monkeypatch, tmp_path):
    monkeypatch.setattr(cv, "ROOT", tmp_path)
    monkeypatch.setattr(cv.shutil, "which", lambda _: None)
    assert "not installed" in cv.audit_pip().message


# --- Decision and override ------------------------------------------------------


def run_decide(findings, errors=(), *, interactive, answers=(), log=None):
    lines = []
    answers = iter(answers)
    code = cv.decide(
        list(findings),
        list(errors),
        interactive=interactive,
        prompt_input=lambda _p: next(answers),
        out=lines.append,
        log=log,
    )
    return code, "\n".join(lines)


def test_clean_or_non_blocking_passes():
    code, text = run_decide([finding("low")], interactive=False)
    assert code == 0 and "passed (1 non-blocking" in text


def test_blocking_fails_without_a_terminal():
    code, text = run_decide([finding()], interactive=False)
    assert code == 1 and "can't be overridden" in text


def test_an_audit_that_cannot_run_blocks():
    code, text = run_decide([], [cv.AuditError("npm", "offline")], interactive=False)
    assert code == 1 and "could not audit npm: offline" in text


def test_interactive_cancel_keeps_it_blocked():
    code, text = run_decide([finding()], interactive=True, answers=[""])
    assert code == 1 and "Push cancelled" in text


def test_override_needs_a_reason():
    code, _ = run_decide([finding()], interactive=True, answers=["override", "  "])
    assert code == 1


def test_interactive_override_is_allowed_and_logged(tmp_path):
    log = tmp_path / "overrides.log"
    code, text = run_decide(
        [finding(), finding("low")],
        [cv.AuditError("pypi", "offline")],
        interactive=True,
        answers=["OVERRIDE", "hotfix for outage"],
        log=log,
    )
    assert code == 0 and "Override recorded" in text
    entry = json.loads(log.read_text())
    assert entry["reason"] == "hotfix for outage"
    assert entry["findings"] == [finding().describe()]
    assert entry["audit_errors"] == ["pypi: offline"]


def test_main_combines_both_audits(monkeypatch):
    monkeypatch.setattr(cv, "audit_npm", lambda: [finding("low")])
    monkeypatch.setattr(cv, "audit_pip", lambda: cv.AuditError("pypi", "offline"))
    assert cv.main(["--no-input"]) == 1
    monkeypatch.setattr(cv, "audit_pip", lambda: [])
    assert cv.main(["--no-input"]) == 0


def test_report_only_warns_about_high_and_critical_but_never_blocks():
    lines = []
    findings = [
        finding("critical", fix=None, package="nofix"),
        finding("high", package="fixable"),
        finding("low", package="minor"),
    ]
    code = cv.report_only(findings, [cv.AuditError("pypi", "offline")], out=lines.append)
    text = "\n".join(lines)
    assert code == 0
    assert (
        "WARNING   [CRITICAL] npm:nofix@1.0.0 GHSA-x (no fix available yet) - presumably there is not yet a fix" in text
    )
    assert "::warning title=Vulnerable runtime dependency (critical)::" in text
    assert "fixable" in text and "a fix is available (pkg@2.0.0)" in text
    assert "info      [LOW] npm:minor" in text
    assert "::warning title=Vulnerability audit did not run::could not audit pypi: offline" in text
    assert "2 high/critical, 1 lower, 1 audit failure(s). Report-only mode: not blocking." in text


def test_report_only_on_a_clean_run():
    lines = []
    assert cv.report_only([], [], out=lines.append) == 0
    assert lines == [
        "Vulnerability report: 0 high/critical, 0 lower, 0 audit failure(s). Report-only mode: not blocking."
    ]


def test_main_report_only_never_blocks(monkeypatch):
    monkeypatch.setattr(cv, "audit_npm", lambda: [finding("critical")])
    monkeypatch.setattr(cv, "audit_pip", lambda: cv.AuditError("pypi", "offline"))
    assert cv.main(["--report-only"]) == 0


def test_main_never_prompts_in_ci(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(cv, "audit_npm", lambda: [finding()])
    monkeypatch.setattr(cv, "audit_pip", lambda: [])
    monkeypatch.setattr(cv, "_tty_input", lambda _p: pytest.fail("prompted in CI"))
    assert cv.main([]) == 1


# --- I/O helpers ---------------------------------------------------------------


def test_fetch_osv_requests_the_advisory_url(monkeypatch):
    import io

    seen = []

    class FakeResponse(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def urlopen(url, timeout):
        seen.append((url, timeout))
        return FakeResponse('{"id": "GHSA-1"}')

    monkeypatch.setattr(cv.urllib.request, "urlopen", urlopen)
    assert cv._fetch_osv("GHSA-1") == {"id": "GHSA-1"}
    assert seen == [("https://api.osv.dev/v1/vulns/GHSA-1", 10)]


def test_has_tty_reflects_whether_the_terminal_can_be_opened(monkeypatch):
    import builtins

    real_open = builtins.open
    monkeypatch.setattr(builtins, "open", lambda *a, **k: real_open(__file__))
    assert cv._has_tty() is True

    def no_tty(*_a, **_k):
        raise OSError("no tty")

    monkeypatch.setattr(builtins, "open", no_tty)
    assert cv._has_tty() is False


def test_tty_input_writes_the_prompt_and_reads_a_line(monkeypatch):
    import builtins
    import io

    class FakeTty(io.StringIO):
        written = ""

        def write(self, text):
            FakeTty.written += text
            return len(text)

    monkeypatch.setattr(builtins, "open", lambda *_a, **_k: FakeTty("override\n"))
    assert cv._tty_input("Proceed? ") == "override\n"
    assert FakeTty.written == "Proceed? "


def test_main_prompts_when_a_terminal_is_attached(monkeypatch, tmp_path):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setattr(cv, "ROOT", tmp_path)
    monkeypatch.setattr(cv, "audit_npm", lambda: [finding()])
    monkeypatch.setattr(cv, "audit_pip", lambda: [])
    monkeypatch.setattr(cv, "_has_tty", lambda: True)
    answers = iter(["override", "known false positive"])
    monkeypatch.setattr(cv, "_tty_input", lambda _p: next(answers))
    assert cv.main([]) == 0
    assert (tmp_path / ".git" / "vuln-overrides.log").exists()


def test_running_as_a_script_exits_with_mains_code():
    import runpy

    with pytest.raises(SystemExit) as exc:
        sys.argv = ["check_vulns.py", "--help"]
        runpy.run_path(str(Path(cv.__file__)), run_name="__main__")
    assert exc.value.code == 0
