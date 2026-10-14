"""Privacy regressions for gateway event and process-boundary logging."""
from __future__ import annotations

import copy
import asyncio
import json
import contextlib
import hashlib
import io
import logging
import socket
import threading
import time

from fastapi.testclient import TestClient

from conftest import FakeAuthorizer, FakeDownstream, FakeRedis, VALID_KEY
from gateway import CARRIED_DOMAINS, create_app
from gateway import obs

AUTH = {"x-api-key": VALID_KEY}
NATIVE = "native-meeting-canary-9f31"
TICKET = "query-ticket-canary-2b76"
CLIENT_IP = "198.51.100.77"


def _json_lines(output: str):
    return [json.loads(line) for line in output.splitlines() if line.startswith("{")]


def test_testclient_logs_no_request_data_and_keeps_safe_route_fields(capsys):
    app = create_app(FakeAuthorizer(user={"user_id": "private-user-321", "scopes": ["bot"]}),
                     FakeDownstream(status_code=200, body={}), FakeRedis())
    headers = {**AUTH, "x-forwarded-for": CLIENT_IP}
    with TestClient(app) as client:
        response = client.get(
            f"/transcripts/google_meet/{NATIVE}?ticket={TICKET}", headers=headers
        )
    assert response.status_code == 403
    output = capsys.readouterr().out
    for canary in (NATIVE, TICKET, CLIENT_IP, "private-user-321", "meeting-api"):
        assert canary not in output
    events = {record.get("event"): record for record in _json_lines(output)}
    assert "request_received" in events
    assert events["request_received"]["level"] != "debug"
    assert "path" not in events["request_received"].get("fields", {})
    assert "request_denied_scope" in events
    assert events["request_denied_scope"]["fields"]["route"] == "/transcripts/{platform}/{native_meeting_id}"


def test_gateway_log_event_sanitizes_direct_stdout(capsys):
    obs.log_event(
        "request_accepted", audience="user", user_id="private-user-321",
        meeting_id=NATIVE,
        fields={"path": f"/transcripts/{NATIVE}?ticket={TICKET}", "host": CLIENT_IP,
                "method": "GET", "downstream_status": 200, "count": 3},
    )
    output = capsys.readouterr().out
    for canary in (NATIVE, TICKET, CLIENT_IP, "private-user-321"):
        assert canary not in output
    record = json.loads(output)
    assert "meeting_id" not in record
    assert "user_id" not in record
    assert "path" not in record.get("fields", {})
    assert record["fields"]["method"] == "GET"
    assert record["fields"]["downstream_status"] == 200
    internal = obs.log_event("request_accepted", audience="user", meeting_id=42)
    internal_record = json.loads(capsys.readouterr().out)
    assert internal_record["meeting_id"] == hashlib.sha256(b"42").hexdigest()[:16]

def test_only_bounded_numeric_internal_ids_are_hashed(capsys):
    for invalid in (True, "native-id", "9" * 21, 10**100):
        event = obs.log_event("request_accepted", audience="user", meeting_id=invalid)
        assert "meeting_id" not in event
    output = capsys.readouterr().out
    assert all("meeting_id" not in record for record in _json_lines(output))


def test_trace_header_is_validated_and_debug_is_below_stdout_floor(capsys):
    app = create_app(FakeAuthorizer(), FakeDownstream(status_code=204), FakeRedis())
    with TestClient(app) as client:
        response = client.get("/health", headers={"x-trace-id": TICKET})
    assert response.headers["x-trace-id"] != TICKET
    assert TICKET not in capsys.readouterr().out
    obs.log_event("debug_probe", audience="system", level="debug")
    obs.log_event("debug_probe", audience="system", level="DEBUG")
    assert capsys.readouterr().out == ""


def test_log_event_does_not_forward_non_allowlisted_values(capsys):
    obs.log_event("downstream_forwarded", audience="system", fields={
        "route": "/transcripts/{meeting_id}", "method": "GET", "status": 202,
        "host": "meeting-api", "url": f"http://meeting-api/{NATIVE}?ticket={TICKET}",
        "ip": CLIENT_IP, "detail": NATIVE,
    })
    output = capsys.readouterr().out
    for canary in (NATIVE, TICKET, CLIENT_IP, "meeting-api"):
        assert canary not in output
    assert _json_lines(output)[0]["fields"]["route"] == "/transcripts/{meeting_id}"


def test_route_field_rejects_raw_meeting_id_even_when_path_has_template_segment(capsys):
    obs.log_event(
        "downstream_forwarded", audience="system",
        fields={"route": f"/transcripts/{{platform}}/{NATIVE}"},
    )
    output = capsys.readouterr().out
    assert NATIVE not in output
    assert "route" not in _json_lines(output)[0].get("fields", {})

def test_actual_uvicorn_access_and_arbitrary_logs_are_sanitized():
    import uvicorn
    from gateway.__main__ import LOG_CONFIG

    app = create_app(FakeAuthorizer(), FakeDownstream(status_code=200, body={}), FakeRedis())
    captured = io.StringIO()
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.listen(128)
    logging_config = copy.deepcopy(LOG_CONFIG)
    logging_config["handlers"]["default"]["stream"] = captured
    config = uvicorn.Config(app, log_config=logging_config, access_log=False, lifespan="off")
    assert config.access_log is False
    server = uvicorn.Server(config)

    def run_server():
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            task = asyncio.new_event_loop()
            asyncio.set_event_loop(task)
            try:
                task.run_until_complete(server.serve(sockets=[sock]))
            finally:
                task.close()

    thread = threading.Thread(target=run_server, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started
    try:
        import httpx
        response = httpx.get(
            f"http://127.0.0.1:{port}/missing/{NATIVE}?ticket={TICKET}",
            headers={**AUTH, "x-forwarded-for": CLIENT_IP}, timeout=2,
        )
        assert response.status_code == 404
        try:
            raise RuntimeError(f"exception-canary-{NATIVE}")
        except RuntimeError:
            logging.getLogger("uvicorn.error").exception(
                "request failed for %s", TICKET,
                extra={
                    "host": CLIENT_IP, "meeting_id": NATIVE, "count": 4,
                    "status": 502, "duration_ms": 12,
                    "trace_id": "feedfacecafebeef0123456789abcdef",
                },
            )
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        sock.close()

    output = captured.getvalue()
    for canary in (NATIVE, TICKET, CLIENT_IP, "private-user-321", "meeting-api"):
        assert canary not in output
    entries = _json_lines(output)
    assert entries
    assert not any(entry.get("logger") == "uvicorn.access" for entry in entries)
    assert any(entry.get("fields") == {"status": 502, "count": 4, "duration_ms": 12}
               for entry in entries)
    assert any(entry.get("trace_id") == "feedfacecafebeef0123456789abcdef"
               for entry in entries)
