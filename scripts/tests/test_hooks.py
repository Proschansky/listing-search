"""Tests for the git hooks in .githooks/.

The hooks are bash, so their cases live in pre_push_cases.sh, which runs them
in a throwaway repo: the pre-push gate running once per version of the code,
skipping documentation-only pushes, and pre-commit skipping documentation-only
commits. This test runs that script and checks it passed.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(shutil.which("bash") is None or shutil.which("make") is None, reason="needs bash and make")
def test_pre_push_runs_the_gate_once_per_version_of_the_code():
    bash = shutil.which("bash")
    assert bash is not None
    result = subprocess.run(  # noqa: S603 - fixed script path, no user input
        [bash, str(ROOT / "scripts/tests/pre_push_cases.sh"), str(ROOT / ".githooks/pre-push")],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ALL PASSED" in result.stdout
