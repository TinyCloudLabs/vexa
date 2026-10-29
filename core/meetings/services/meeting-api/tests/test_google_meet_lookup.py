"""TC-2181: real Google Meet lookup paths remain distinct, reachable meeting keys."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn import build_router
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.collector import create_app
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.collector.meeting_link import parse_meeting_url
from meeting_api.lifecycle.stop_router import InMemoryCommandPublisher, build_stop_router
from test_bot_spawn import HEADERS, USER, _client, _spawn_env
from test_planned_meetings import _CaptureRedis


@pytest.mark.parametrize("value", [
    "https://meet.google.com/lookup/Team_Sync-42",
    "https://meet.google.com/lookup/Team_Sync-42/?authuser=1#join",
    "meet.google.com/lookup/Team_Sync-42",
    "lookup/Team_Sync-42",
])
def test_lookup_identity_is_the_real_path(value):
    assert parse_meeting_url(value) == ("google_meet", "lookup/Team_Sync-42")


INVALID_PATHS = [
    "/lookup", "/lookup/", "/lookup//daily", "/lookup/daily/extra",
    "/other/lookup/daily", "/lookup/../daily", "/lookup/daily/abc-defg-hij",
    "/lookup/%2Fdaily", "/lookup/daily%20sync", "/lookup/daily%3Fsync",
    "/lookup/daily sync", "/lookup/daily.sync", "/lookup/" + "a" * 249,
]


@pytest.mark.parametrize("path", INVALID_PATHS)
def test_invalid_lookup_paths_are_not_meeting_ids(path):
    assert parse_meeting_url("https://meet.google.com" + path) is None


@pytest.mark.parametrize("id_fields", [{}, {"native_meeting_id": None}])
def test_two_lookup_links_dispatch_separately_and_deduplicate_stably(monkeypatch, id_fields):
    _spawn_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    client = _client(repo, runtime)
    responses = []
    for nick in ("daily", "weekly"):
        response = client.post("/bots", headers=HEADERS, json={
            "platform": "google_meet", "meeting_url": f"https://meet.google.com/lookup/{nick}",
            **id_fields,
        })
        assert response.status_code == 201, response.text
        assert response.json()["native_meeting_id"] == f"lookup/{nick}"
        responses.append(response.json())
    assert responses[0]["id"] != responses[1]["id"]
    assert {row["native_meeting_id"] for row in repo._meetings.values()} == {
        "lookup/daily", "lookup/weekly",
    }
    retry = client.post("/bots", headers=HEADERS, json={
        "meeting_url": "https://meet.google.com/lookup/daily/?authuser=1", **id_fields,
    })
    assert retry.status_code == 409, retry.text
    assert [json.loads(spec["env"]["BOT_CONFIG"])["meetingUrl"] for spec in runtime.specs] == [
        "https://meet.google.com/lookup/daily", "https://meet.google.com/lookup/weekly",
    ]


def test_null_id_without_url_is_missing_not_none_string(monkeypatch):
    _spawn_env(monkeypatch)
    repo = InMemoryMeetingRepo()
    response = _client(repo).post("/bots", headers=HEADERS, json={
        "platform": "google_meet", "native_meeting_id": None,
    })
    assert response.status_code == 422, response.text
    assert repo._meetings == {}


@pytest.mark.parametrize("id_fields", [{}, {"native_meeting_id": None}, {"native_meeting_id": "abc-defg-hij"}])
def test_dashed_codes_keep_their_identity_and_join_url(monkeypatch, id_fields):
    _spawn_env(monkeypatch)
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    response = _client(repo, runtime).post("/bots", headers=HEADERS, json={
        "platform": "google_meet", "meeting_url": "https://meet.google.com/abc-defg-hij", **id_fields,
    })
    assert response.status_code == 201, response.text
    assert response.json()["native_meeting_id"] == "abc-defg-hij"
    assert json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])["meetingUrl"] == "https://meet.google.com/abc-defg-hij"


@pytest.mark.parametrize("path", INVALID_PATHS)
def test_invalid_lookup_dispatch_leaves_no_row(monkeypatch, path):
    _spawn_env(monkeypatch)
    repo = InMemoryMeetingRepo()
    response = _client(repo).post("/bots", headers=HEADERS, json={
        "meeting_url": "https://meet.google.com" + path, "native_meeting_id": None,
    })
    assert response.status_code == 422, response.text
    assert repo._meetings == {}


def test_explicit_lookup_native_id_constructs_the_real_url(monkeypatch):
    _spawn_env(monkeypatch)
    runtime = FakeRuntimeClient()
    response = _client(InMemoryMeetingRepo(), runtime).post("/bots", headers=HEADERS, json={
        "platform": "google_meet", "native_meeting_id": "lookup/abc-defg-hij",
    })
    assert response.status_code == 201, response.text
    assert response.json()["native_meeting_id"] == "lookup/abc-defg-hij"
    assert json.loads(runtime.specs[0]["env"]["BOT_CONFIG"])["meetingUrl"] == "https://meet.google.com/lookup/abc-defg-hij"


@pytest.mark.parametrize("native_id", ["lookup/", "lookup/a/b", "lookup/a?x", "lookup/%2Fa", "lookup/../a"])
def test_invalid_explicit_lookup_id_is_refused(monkeypatch, native_id):
    _spawn_env(monkeypatch)
    repo = InMemoryMeetingRepo()
    response = _client(repo).post("/bots", headers=HEADERS, json={
        "platform": "google_meet", "native_meeting_id": native_id,
    })
    assert response.status_code == 422, response.text
    assert repo._meetings == {}


def test_lookup_native_key_can_be_read_annotated_and_stopped(monkeypatch):
    _spawn_env(monkeypatch)
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=USER, platform="google_meet", native_meeting_id="lookup/daily", status="active")
    collector = TestClient(create_app(store, _CaptureRedis()))
    path = "/meetings/google_meet/lookup/daily"
    response = collector.post(path + "/annotate", headers=HEADERS, json={"title": "Daily"})
    assert response.status_code == 200, response.text
    transcript = collector.get("/transcripts/google_meet/lookup/daily", headers=HEADERS)
    assert transcript.status_code == 200, transcript.text
    assert transcript.json()["native_meeting_id"] == "lookup/daily"
    assert collector.get("/transcripts/google_meet/lookup/daily", headers={"x-user-id": "8"}).status_code == 404

    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    app = FastAPI()
    app.include_router(build_router(repo, runtime))
    app.include_router(build_stop_router(repo, InMemoryCommandPublisher(), runtime))
    client = TestClient(app)
    spawned = client.post("/bots", headers=HEADERS, json={"meeting_url": "https://meet.google.com/lookup/daily"})
    assert spawned.status_code == 201, spawned.text
    stopped = client.delete("/bots/google_meet/lookup/daily", headers=HEADERS)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["status"] == "stopping"
