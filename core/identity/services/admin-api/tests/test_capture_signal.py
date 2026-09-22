"""Fixture collection (O-TEL-1) — the ``capture_signal`` flag on ``/internal/users/{id}/bot-context``.

Captured signal is an explicit, bounded diagnostic opt-in. Empty or malformed settings must never
allocate a tape. The flag resolves user > platform_settings > default-off.

Two layers, deliberately split:
  * the RESOLVER (``_resolve_capture_signal``) — pure, so the three resolutions + the default + the
    unrecognized-value fall-through are provable with no docker, no DB, no HTTP;
  * the EDGE (bot-context over the internal secret) — the same testcontainers-PG harness the other
    settings evals use, proving the platform kill switch reaches the response and that clearing it
    restores the default.

The per-user tier has no HTTP writer today (``UserAdminPatch.data`` is a closed billing model), so
it is a DB-level escape hatch — covered at the resolver, which is where its logic lives.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.main import _resolve_capture_signal, create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine


# ── the resolver: pure, always runs (no docker) ────────────────────────────────────────────────

def test_capture_signal_defaults_off_when_nothing_is_explicitly_configured():
    assert _resolve_capture_signal({}, {}) is False
    assert _resolve_capture_signal({"diagnostics": {}}, {}) is False
    assert _resolve_capture_signal({}, {"capture_signal": ""}) is False


def test_capture_signal_platform_explicit_opt_in_and_kill_switch():
    assert _resolve_capture_signal({}, {"capture_signal": "false"}) is False
    assert _resolve_capture_signal({}, {"capture_signal": "0"}) is False
    assert _resolve_capture_signal({}, {"capture_signal": "off"}) is False
    assert _resolve_capture_signal({}, {"capture_signal": "true"}) is True


def test_capture_signal_user_beats_platform_in_both_directions():
    off_user = {"diagnostics": {"capture_signal": "false"}}
    on_user = {"diagnostics": {"capture_signal": "true"}}
    # An account that must not be taped stays off even where the platform collects…
    assert _resolve_capture_signal(off_user, {"capture_signal": "true"}) is False
    assert _resolve_capture_signal(off_user, {}) is False
    # …and an explicit per-user ON survives the platform kill switch (opt-in for a debug account).
    assert _resolve_capture_signal(on_user, {"capture_signal": "false"}) is True
    # Booleans read the same as the string form (a DB-level write may store a real JSON bool).
    assert _resolve_capture_signal({"diagnostics": {"capture_signal": False}}, {}) is False


def test_capture_signal_unrecognized_value_falls_through_to_explicit_opt_in_only():
    assert _resolve_capture_signal({"diagnostics": {"capture_signal": "flase"}},
                                   {"capture_signal": "false"}) is False
    assert _resolve_capture_signal({"diagnostics": {"capture_signal": "flase"}}, {}) is False
    # A non-dict diagnostics blob never raises — it resolves to disabled.
    assert _resolve_capture_signal({"diagnostics": "nope"}, {}) is False


# ── the edge: bot-context over the internal secret (testcontainers PG) ─────────────────────────

@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _internal():
    return {"X-Internal-Secret": INTERNAL_SECRET}


@requires_docker
def test_bot_context_carries_capture_signal_and_honors_the_kill_switch(client):
    uid = client.post("/admin/users", headers=_admin(),
                      json={"email": "capture@vexa.ai"}).json()["id"]

    # Default OFF, and ALWAYS present — bot_spawn never guesses when identity is unavailable.
    body = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()
    assert body["capture_signal"] is False

    # The kill switch: one settings write, every subsequent spawn stops taping.
    r = client.put("/internal/settings/diagnostics", headers=_internal(),
                   json={"capture_signal": "false"})
    assert r.status_code == 200, r.text
    assert client.get(f"/internal/users/{uid}/bot-context",
                      headers=_internal()).json()["capture_signal"] is False

    # An explicit true enables collection, then clearing the field returns to disabled.
    client.put("/internal/settings/diagnostics", headers=_internal(), json={"capture_signal": "true"})
    assert client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()["capture_signal"] is True
    client.put("/internal/settings/diagnostics", headers=_internal(), json={"capture_signal": ""})
    assert client.get("/internal/settings/diagnostics", headers=_internal()).json()["value"] == {}
    assert client.get(f"/internal/users/{uid}/bot-context",
                      headers=_internal()).json()["capture_signal"] is False
