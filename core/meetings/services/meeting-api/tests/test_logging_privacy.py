from __future__ import annotations

import hashlib
import io
import json
import logging
import re

from meeting_api.obs import LOG_CONFIG, PrivacyFilter, log_event


def test_log_event_sanitizes_event_payload_and_hashes_internal_meeting_id():
    output = io.StringIO()
    record = log_event(
        "transcript_served", audience="user", meeting_id="381",
        user_id="user-canary-91",
        fields={"segments": 4, "platform": "google_meet",
                "transcript": "transcript-canary-72", "path": "/private/path-canary-8"},
        stream=output,
    )
    line = output.getvalue()
    payload = json.loads(line)
    assert "transcript-canary-72" not in line
    assert "path-canary-8" not in line
    assert "user-canary-91" not in line
    assert payload["meeting_id"] == hashlib.sha256(b"381").hexdigest()[:16]
    assert payload["fields"] == {"segments": 4, "platform": "google_meet"}
    assert re.fullmatch(r"[0-9a-f]{32}", payload["trace_id"])
    assert record["meeting_id"] == payload["meeting_id"]

def test_log_event_drops_unapproved_event_text():
    output = io.StringIO()
    log_event("synth_name_canary_965b", audience="system", stream=output)
    assert "synth_name_canary_965b" not in output.getvalue()


def test_filter_removes_message_exception_and_unrecognized_extra_fields():
    record = logging.LogRecord(
        "meeting_api.test", logging.ERROR, __file__, 1,
        "query=%s", ("SQL-canary-42",), None,
    )
    record.sql = "SELECT transcript-canary-73"
    record.status_code = 500
    record.trace_id = "trace-header-canary-62"
    record.exc_info = (RuntimeError, RuntimeError("exception-canary-33"), None)

    assert PrivacyFilter().filter(record)
    cooked = logging.Formatter().format(record)
    assert "SQL-canary-42" not in cooked
    assert "transcript-canary-73" not in cooked
    assert "exception-canary-33" not in cooked
    assert "trace-header-canary-62" not in cooked
    assert re.fullmatch(r"[0-9a-f]{32}", record.trace_id)
    assert record.status_code == 500
    assert not hasattr(record, "sql")
    assert record.exc_info is None
    assert record.exc_text is None


def test_log_event_drops_user_and_unrecognized_trace_header():
    output = io.StringIO()
    result = log_event(
        "request_received", audience="operator", user_id="user-canary-84",
        fields={"request_id": "request-canary-93"},
        trace_id="trace-header-canary-62", stream=output,
    )
    text = output.getvalue()
    assert "user-canary-84" not in text
    assert "trace-header-canary-62" not in text
    assert "request-canary-93" not in text
    assert re.fullmatch(r"[0-9a-f]{32}", result["trace_id"])


def test_uvicorn_process_output_scrubs_native_paths_and_sql_exceptions():
    import socket
    import subprocess
    import sys
    from pathlib import Path

    source = Path(__file__).resolve().parents[1] / "src"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    script = r"""
import sys, threading, time, urllib.error, urllib.request
sys.path.insert(0, sys.argv[1])
import uvicorn
from meeting_api import create_app
from meeting_api.obs import LOG_CONFIG, configure_privacy_logging
configure_privacy_logging()
app = create_app()
@app.get("/explode")
async def explode():
    try:
        from sqlalchemy.exc import StatementError
    except ImportError:
        raise RuntimeError("SQL-CANARY transcript-CANARY-500 native abc-defg-hij")
    raise StatementError(
        "synthetic database failure",
        "SELECT 'SQL-CANARY' WHERE native='abc-defg-hij' AND text='transcript-CANARY-500'",
        {"native": "abc-defg-hij", "transcript": "transcript-CANARY-500"},
        RuntimeError("driver-CANARY-500"), hide_parameters=False,
    )
server = uvicorn.Server(uvicorn.Config(
    app, host="127.0.0.1", port=int(sys.argv[2]), access_log=False,
    log_config=LOG_CONFIG, lifespan="off",
))
assert server.config.access_log is False
thread = threading.Thread(target=server.run)
thread.start()
deadline = time.monotonic() + 8
while not server.started and time.monotonic() < deadline:
    time.sleep(.01)
try:
    urllib.request.urlopen(
        f"http://127.0.0.1:{sys.argv[2]}/missing/abc-defg-hij?ticket=query-CANARY-404",
        timeout=2,
    )
except urllib.error.HTTPError as error:
    assert error.code == 404
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[2]}/explode", timeout=2)
except urllib.error.HTTPError as error:
    assert error.code == 500
server.should_exit = True
thread.join(timeout=5)
"""
    proc = subprocess.run(
        [sys.executable, "-c", script, str(source), str(port)],
        capture_output=True, text=True, timeout=15,
    )
    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    for canary in (
        "abc-defg-hij", "query-CANARY-404", "SQL-CANARY",
        "transcript-CANARY-500", "driver-CANARY-500", "127.0.0.1",
    ):
        assert canary not in output
    assert '"status_code":500' in output
    assert '"event":"request_failed"' in output


def test_process_json_logging_config_filters_root_and_uvicorn_handlers():
    assert LOG_CONFIG["formatters"]["json"]["()"] == "meeting_api.obs.JSONFormatter"
    assert "privacy" in LOG_CONFIG["handlers"]["default"]["filters"]
    assert "privacy" in LOG_CONFIG["handlers"]["access"]["filters"]
    assert all(
        "privacy" in LOG_CONFIG["handlers"][name]["filters"]
        for name in LOG_CONFIG["root"]["handlers"]
    )


def test_log_event_enforces_info_floor():
    output = io.StringIO()
    log_event("debug_only", audience="system", level="debug", stream=output)
    assert output.getvalue() == ""


def test_collector_handler_logs_only_hashed_row_and_safe_counts(capsys):
    from fastapi.testclient import TestClient

    from meeting_api.collector.app import create_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore

    store = InMemoryTranscriptStore()
    meeting_id = store.seed_meeting(
        user_id=41, platform="google_meet", native_meeting_id="native-CANARY-32",
        segments=[{"segment_id": "segment-CANARY-12", "start": 0, "end": 1,
                   "text": "transcript-CANARY-73", "language": "en"}],
    )
    client = TestClient(create_app(store, redis=None))
    response = client.get(
        f"/transcripts/by-id/{meeting_id}",
        headers={"x-user-id": "41", "x-trace-id": "trace-header-CANARY-83"},
    )
    assert response.status_code == 200
    output = capsys.readouterr().out
    assert "native-CANARY-32" not in output
    assert "segment-CANARY-12" not in output
    assert "transcript-CANARY-73" not in output
    assert "trace-header-CANARY-83" not in output
    assert '"user_id"' not in output
    assert re.search(r'"trace_id":"[0-9a-f]{32}"', output)
    assert hashlib.sha256(str(meeting_id).encode()).hexdigest()[:16] in output
    assert '"segments":1' in output


def test_collector_document_paths_are_absent_from_logs(capsys):
    from fastapi.testclient import TestClient

    from meeting_api.collector.app import create_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore

    path = "/private/TC965_DOC_PATH_CANARY.md"
    native_id = "native-doc-CANARY-965b"
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=13, platform="google_meet", native_meeting_id=native_id)
    client = TestClient(create_app(store, redis=None))
    connected = client.post(
        f"/meetings/google_meet/{native_id}/docs",
        json={"path": path, "workspace": "workspace-CANARY-965b"},
        headers={"x-user-id": "13"},
    )
    disconnected = client.request(
        "DELETE", f"/meetings/google_meet/{native_id}/docs",
        json={"path": path}, headers={"x-user-id": "13"},
    )
    assert connected.status_code == disconnected.status_code == 200

    output = capsys.readouterr().out
    for canary in (path, native_id, "workspace-CANARY-965b", '"user_id"'):
        assert canary not in output
    events = [json.loads(line) for line in output.splitlines()]
    assert any(e["event"] == "meeting_doc_connected" and e["fields"] == {"docs": 1} for e in events)
    assert any(e["event"] == "meeting_doc_disconnected" and e["fields"] == {"docs": 0} for e in events)



def test_scheduler_duplicate_key_log_omits_idempotency_key(caplog):
    from meeting_api.scheduling import FakeClock, Scheduler

    key = "idempotency-CANARY-57"
    scheduler = Scheduler(dispatch=lambda request: {}, clock=FakeClock(start=0))
    spec = {"execute_at": 10, "request": {"url": "https://service.invalid/private-CANARY-90"},
            "idempotency_key": key}
    scheduler.schedule(spec)
    caplog.set_level(logging.INFO, logger="meeting_api.scheduling.scheduler")
    scheduler.schedule(spec)
    assert "duplicate scheduled job" in caplog.text
    assert key not in caplog.text
    assert "private-CANARY-90" not in caplog.text


async def test_signal_upload_and_janitor_logs_omit_session_and_object_paths(capsys):
    from meeting_api.recordings import sweep_signal_tapes, upload_signal_tape
    from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage

    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=3841, user_id=9283, session_uid="session-CANARY-51")
    storage = InMemoryStorage()
    await upload_signal_tape(
        repo, storage, token_meeting_id=None, session_uid="session-CANARY-51",
        data=b"synthetic", part="captured-signal",
    )
    await sweep_signal_tapes(storage, budget_bytes=0, min_age_s=0, now=10**12)
    output = capsys.readouterr().out
    assert "session-CANARY-51" not in output
    assert "signal/" not in output
    assert "9283" not in output
    assert hashlib.sha256(b"3841").hexdigest()[:16] in output
    assert "signal_tape_evicted" in output


async def test_bot_spawn_logs_hash_row_but_not_native_or_user_ids(capsys):
    from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
    from meeting_api.bot_spawn.service import request_bot

    repo = InMemoryMeetingRepo()
    user_id = 98273461
    native_id = "native-CANARY-85"
    result = await request_bot(
        repo, FakeRuntimeClient(), user_id=user_id, platform="google_meet",
        native_meeting_id=native_id, redis_url="redis://synthetic.invalid",
        token_secret="synthetic-token",
    )
    output = capsys.readouterr().out
    assert result["id"] is not None
    assert native_id not in output
    assert str(user_id) not in output
    assert hashlib.sha256(str(result["id"]).encode()).hexdigest()[:16] in output


def test_webhook_callback_logs_outcome_without_host_or_identifier(goldens, capsys):
    import asyncio

    from fastapi.testclient import TestClient

    from meeting_api import create_app
    from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
    from meeting_api.webhooks import DeliveryResult

    class Sink:
        async def deliver(self, *args, **kwargs):
            return DeliveryResult(status="delivered", status_code=204)

    repo = InMemoryMeetingRepo()
    row = asyncio.run(repo.create_meeting(
        user_id=824691, platform="google_meet", native_meeting_id="native-CANARY-24",
        data={"webhook_url": "https://host-CANARY-24/path-CANARY-24?token=token-CANARY-24",
              "webhook_secret": "secret-CANARY-24"},
    ))
    asyncio.run(repo.create_session(meeting_id=row["id"], session_uid="session-CANARY-24"))
    client = TestClient(create_app(meeting_repo=repo, webhook_sink=Sink()))
    event = {**goldens["joining"], "connection_id": "session-CANARY-24"}
    response = client.post("/bots/internal/callback/lifecycle", json=event)
    assert response.status_code == 200
    output = capsys.readouterr().out
    for canary in (
        "host-CANARY-24", "path-CANARY-24", "token-CANARY-24",
        "secret-CANARY-24", "native-CANARY-24", "session-CANARY-24", "824691",
    ):
        assert canary not in output
    assert hashlib.sha256(str(row["id"]).encode()).hexdigest()[:16] in output
