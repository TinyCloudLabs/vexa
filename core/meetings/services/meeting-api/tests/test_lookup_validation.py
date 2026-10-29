"""Lookup path validation keeps the bare-nickname identity shipped in #22."""
import json
from datetime import datetime

import pytest

from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.calendar_sync import parse_ics, sync_user
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.collector.meeting_link import find_meeting_link, parse_meeting_url
from test_auto_join_sweep import _tick
from test_bot_spawn import HEADERS, _client, _spawn_env
from test_calendar_sync import NOW, USER, _event, _ics


INVALID_LOOKUPS = [
    "/lookup/daily;x", "/lookup/daily;", "/lookup/daily/;x", "/lookup;params/abc-defg-hij",
    "/lookup/a/abc-defg-hij", "/lookup//abc-defg-hij", "/lookup/abc-defg-hij/extra",
    "/lookup/;params/abc-defg-hij",
]


@pytest.mark.parametrize("path", INVALID_LOOKUPS)
def test_malformed_lookup_is_not_reinterpreted_as_a_meeting_code(path):
    assert parse_meeting_url("https://meet.google.com" + path) is None


@pytest.mark.parametrize("path", INVALID_LOOKUPS)
@pytest.mark.parametrize("id_fields", [{}, {"native_meeting_id": None}])
def test_malformed_lookup_dispatch_is_422_without_a_row(monkeypatch, path, id_fields):
    _spawn_env(monkeypatch)
    repo = InMemoryMeetingRepo()
    response = _client(repo).post("/bots", headers=HEADERS, json={
        "meeting_url": "https://meet.google.com" + path, **id_fields,
    })
    assert response.status_code == 422, response.text
    assert repo._meetings == {}


@pytest.mark.parametrize("id_fields", [{}, {"native_meeting_id": None}])
def test_lookup_dispatch_retains_bare_nickname_and_stable_dedup(monkeypatch, id_fields):
    _spawn_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    client = _client(repo, runtime)
    for nick in ("daily", "weekly"):
        url = f"https://meet.google.com/lookup/{nick}"
        response = client.post("/bots", headers=HEADERS, json={"meeting_url": url, **id_fields})
        assert response.status_code == 201, response.text
        assert response.json()["native_meeting_id"] == nick
    duplicate = client.post("/bots", headers=HEADERS, json={
        "meeting_url": "https://meet.google.com/lookup/daily/?authuser=1", **id_fields,
    })
    assert duplicate.status_code == 409, duplicate.text
    assert {row["native_meeting_id"] for row in repo._meetings.values()} == {"daily", "weekly"}
    assert [json.loads(spec["env"]["BOT_CONFIG"])["meetingUrl"] for spec in runtime.specs] == [
        "https://meet.google.com/lookup/daily", "https://meet.google.com/lookup/weekly",
    ]


@pytest.mark.parametrize("auto_join", [False, True])
@pytest.mark.parametrize("location,description", [
    ("https://meet.google.com/lookup/TeamNick", None),
    ("Conference room", "Join: https://meet.google.com/lookup/TeamNick"),
])
async def test_calendar_lookup_preserves_key_and_honors_auto_join_policy(monkeypatch, auto_join, location, description):
    _spawn_env(monkeypatch)
    store = InMemoryTranscriptStore()
    parsed = parse_ics(_ics(_event(location=location, description=description)), now=NOW)
    await sync_user(store, USER, parsed, auto_join_default=auto_join)
    (row,) = await store.list_meetings(USER)
    assert row["platform"] == "google_meet"
    assert row["native_meeting_id"] == "TeamNick"
    assert row["status"] == "scheduled"
    assert row["data"]["auto_join"] is auto_join
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    repo._meetings[row["id"]] = row
    counters = await _tick(repo, runtime, now=datetime.fromisoformat(row["data"]["scheduled_at"]))
    if auto_join:
        assert counters["spawned"] == 1
        assert json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])["meetingUrl"] == "https://meet.google.com/lookup/TeamNick"
        assert repo._meetings[row["id"]]["native_meeting_id"] == "TeamNick"
    else:
        assert counters["due"] == 0
        assert runtime.specs == []


@pytest.mark.parametrize("path", INVALID_LOOKUPS)
@pytest.mark.parametrize("source", ["location", "description"])
async def test_malformed_lookup_calendar_event_is_linkless_and_not_dispatched(monkeypatch, path, source):
    _spawn_env(monkeypatch)
    store = InMemoryTranscriptStore()
    url = "https://meet.google.com" + path
    event = _event(location=url) if source == "location" else _event(
        location="Conference room", description=f"Join {url} thanks",
    )
    parsed = parse_ics(_ics(event), now=NOW)
    await sync_user(store, USER, parsed, auto_join_default=True)
    (row,) = await store.list_meetings(USER)
    assert row["platform"] == "unknown"
    assert row["native_meeting_id"] is None
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    repo._meetings[row["id"]] = row
    counters = await _tick(repo, runtime, now=datetime.fromisoformat(row["data"]["scheduled_at"]))
    assert counters["due"] == 0
    assert runtime.specs == []


@pytest.mark.parametrize("punctuation", [";", ";)", ";."])
def test_lookup_semicolon_in_prose_is_not_trimmed_into_a_joinable_link(punctuation):
    assert find_meeting_link(
        f"Join https://meet.google.com/lookup/daily{punctuation} thanks"
    ) is None
