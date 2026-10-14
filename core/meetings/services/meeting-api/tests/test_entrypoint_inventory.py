from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from entrypoint_privacy_python import entrypoint_rows, run_python_entrypoint_canary  # noqa: E402


@pytest.mark.parametrize(
    "row",
    entrypoint_rows("core/meetings/services/meeting-api/src"),
    ids=lambda row: row["id"],
)
def test_python_entrypoint_startup_canary_is_filtered(row):
    run_python_entrypoint_canary(row)
