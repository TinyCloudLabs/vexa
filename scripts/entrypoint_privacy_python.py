"""Subprocess helpers for Python entrypoint rows in log-privacy-entrypoints.json."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "scripts" / "log-privacy-entrypoints.json"
CANARIES = (
    "TC965_STARTUP_NAME_CANARY",
    "TC965_STARTUP_TEXT_CANARY",
    "xxx-xxxx-xxx",
    "TC965_STARTUP_TOKEN_CANARY",
    "Traceback",
    "RuntimeError",
)


def entrypoint_rows(source_root: str) -> list[dict[str, str]]:
    entries = json.loads(MANIFEST.read_text())["entries"]
    return [
        row for row in entries
        if row.get("test_scope") == "vexa-ci"
        and row.get("language") == "python"
        and row.get("source_root") == source_root
        and row["harness"] in {"python-main", "python-uvicorn"}
    ]


def run_python_entrypoint_canary(row: dict[str, str]) -> None:
    source = ROOT / row["source_root"]
    builder = "gateway.adapters" if row["service"] == "gateway" else row["module"]
    script = r'''
import importlib, logging, sys, types
sys.path.insert(0, sys.argv[1])
module_name, builder_name, target, filter_module, filter_name, harness = sys.argv[2:]
entry = importlib.import_module(module_name)
build = importlib.import_module(builder_name)

def import_from_string(value):
    module_name, attr = value.split(':', 1)
    return getattr(importlib.import_module(module_name), attr)

importer = types.ModuleType("uvicorn.importer")
importer.import_from_string = import_from_string
sys.modules["uvicorn.importer"] = importer
uvicorn = types.ModuleType("uvicorn")
uvicorn.importer = importer
uvicorn.run = None
sys.modules["uvicorn"] = uvicorn

def canary_app():
    try:
        raise RuntimeError("TC965_STARTUP_TEXT_CANARY https://meet.google.com/xxx-xxxx-xxx?token=TC965_STARTUP_TOKEN_CANARY")
    except RuntimeError:
        logging.getLogger("startup.child").warning("TC965_STARTUP_NAME_CANARY", exc_info=True)
    return object()

build.build_production_app = canary_app

def assert_filtered():
    handlers = list(logging.getLogger().handlers)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        handlers.extend(logging.getLogger(name).handlers)
    filters = [f for handler in handlers for f in handler.filters]
    assert any(type(f).__name__ == filter_name and type(f).__module__ == filter_module for f in filters), (filter_name, filter_module, filters)

def fake_run(app, **kwargs):
    assert kwargs.get("access_log") is False
    assert_filtered()
    if isinstance(app, str):
        import_from_string(app)

uvicorn.run = fake_run
if harness == "python-main":
    entry.main()
else:
    import_from_string(target)
assert_filtered()
'''
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(source),
            row["module"],
            builder,
            row.get("target_module", ""),
            row["filter_module"],
            row["filter_name"],
            row["harness"],
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, f"{row['id']} failed: {output}"
    for canary in CANARIES:
        assert canary not in output, f"{row['id']} leaked {canary}: {output}"


def run_process_hook_canaries(source_root: str, module: str, configure_name: str) -> None:
    source = ROOT / source_root
    script = r'''
import gc, importlib, sys, threading, warnings
sys.path.insert(0, sys.argv[1])
module_name, configure_name, event = sys.argv[2:]
obs = importlib.import_module(module_name)
getattr(obs, configure_name)()
canary = f"TC965_{event.upper()}_CANARY https://meet.google.com/xxx-xxxx-xxx?ticket=TC965_HOOK_TOKEN"
if event == "warning":
    warnings.warn(canary, RuntimeWarning)
elif event == "thread":
    def fail():
        raise RuntimeError(canary)
    thread = threading.Thread(target=fail)
    thread.start()
    thread.join()
elif event == "unraisable":
    class BadDestructor:
        def __del__(self):
            raise RuntimeError(canary)
    bad = BadDestructor()
    del bad
    gc.collect()
elif event == "uncaught":
    raise RuntimeError(canary)
else:
    raise AssertionError(event)
'''
    for event in ("uncaught", "thread", "warning", "unraisable"):
        result = subprocess.run(
            [sys.executable, "-c", script, str(source), module, configure_name, event],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=15,
        )
        output = result.stdout + result.stderr
        expected_status = 1 if event == "uncaught" else 0
        assert result.returncode == expected_status, f"{module} {event}: {output}"
        for value in (f"TC965_{event.upper()}_CANARY", "xxx-xxxx-xxx", "TC965_HOOK_TOKEN", "Traceback", "RuntimeError"):
            assert value not in output, f"{module} {event} leaked {value}: {output}"
        records = [line for line in output.splitlines() if line.startswith("{")]
        assert records, f"{module} {event} emitted no sanitized record"
        for line in records:
            import json
            payload = json.loads(line)
            assert set(payload) <= {"ts", "level", "event", "service", "logger", "trace_id", "audience"}
