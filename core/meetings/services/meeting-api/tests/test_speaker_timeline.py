import json

import pytest

from meeting_api.recordings.service import upload_chunk
from meeting_api.recordings.speaker_timeline import read_timeline, validate_timeline
from meeting_api.bot_spawn import mint_meeting_token
from test_recordings import _seeded, _client_for, _wav, MEETING_ID, SESSION_UID, USER, SECRET


def part(start=0, end=15000, name="Alice"):
    return {"version": 1, "recording_started_at_ms": 1800000000000, "capped": False,
            "intervals": [{"start_ms": start, "end_ms": end, "participant_id": name,
                           "name": name, "attribution": "identified"}]}


async def send(repo, storage, seq, timeline, final=False):
    return await upload_chunk(repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
                              data=_wav(), media_format="wav", chunk_seq=seq, is_final=final,
                              speaker_timeline=timeline)


async def test_timeline_is_incremental_idempotent_and_recording_owned():
    repo, storage = _seeded()
    first = await send(repo, storage, 0, part())
    rid = first["recording_id"]
    assert first["speaker_timeline"] == "stored"
    with pytest.raises(ValueError, match="incomplete"):
        await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=rid)
    await send(repo, storage, 1, part(15000, 30000, "Bob"), final=True)
    await send(repo, storage, 1, part(15000, 30000, "Bob"), final=True)
    timeline = await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=rid)
    assert [s["name"] for s in timeline["intervals"]] == ["Alice", "Bob"]
    assert len(await storage.list(f"recordings/{USER}/{rid}/{SESSION_UID}/speaker-timeline/")) == 2
    assert await read_timeline(storage, session_uid=SESSION_UID, owner=USER + 1, recording_id=rid) is None
    client = _client_for(repo, storage)
    assert client.get(f"/recordings/{rid}/speaker-timeline", headers={"x-user-id": str(USER)}).json() == timeline
    assert client.get(f"/recordings/{rid}/speaker-timeline", headers={"x-user-id": str(USER + 1)}).status_code == 404
    assert client.get(f"/recordings/{rid}/speaker-timeline").status_code in (400, 401)


async def test_bad_metadata_does_not_lose_audio_and_conflicting_clocks_are_rejected():
    repo, storage = _seeded()
    first = await send(repo, storage, 0, {"version": 2})
    assert first["speaker_timeline"] == "unavailable"
    assert await storage.get(first["storage_path"]) == _wav()
    assert await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=first["recording_id"]) is None
    await send(repo, storage, 0, part())
    different_clock = {**part(15000, 30000), "recording_started_at_ms": 1800000001000}
    await send(repo, storage, 1, different_clock, final=True)
    with pytest.raises(ValueError, match="clocks disagree"):
        await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=first["recording_id"])


async def test_final_upload_does_not_certify_missing_metadata_parts():
    repo, storage = _seeded()
    first = await send(repo, storage, 0, part())
    await send(repo, storage, 2, part(30000, 45000), final=True)
    with pytest.raises(ValueError, match="missing chunks"):
        await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=first["recording_id"])
    client = _client_for(repo, storage)
    assert client.get(f"/recordings/{first['recording_id']}/speaker-timeline",
                      headers={"x-user-id": str(USER)}).status_code == 422


async def test_missing_audio_chunk_invalidates_surviving_speaker_timing():
    repo, storage = _seeded()
    first = await send(repo, storage, 0, part())
    await send(repo, storage, 1, part(15000, 30000), final=True)
    assert await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=first["recording_id"])
    await storage.delete(first["storage_path"])
    with pytest.raises(ValueError, match="audio chunks incomplete"):
        await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=first["recording_id"])


@pytest.mark.parametrize("value", [None, {}, {**part(), "intervals": part()["intervals"] * 257},
    {**part(), "recording_started_at_ms": float("nan")},
    {**part(), "intervals": [{**part()["intervals"][0], "start_ms": -1}]},
    {**part(), "intervals": [{**part()["intervals"][0], "name": "x" * 100000}]}])
def test_invalid_or_oversized_metadata(value):
    with pytest.raises(ValueError):
        validate_timeline(value)


def test_authenticated_multipart_upload_retains_metadata_and_rejects_other_meeting():
    repo, storage = _seeded()
    client = _client_for(repo, storage)
    metadata = {"session_uid": SESSION_UID, "media_type": "audio", "media_format": "wav",
                "chunk_seq": 0, "is_final": True, "speaker_timeline": part()}
    def upload(meeting_id):
        token = mint_meeting_token(meeting_id, USER, "google_meet", "fixture", secret=SECRET)
        return client.post("/internal/recordings/upload",
                           headers={"Authorization": f"Bearer {token}"},
                           data={"metadata": json.dumps(metadata)},
                           files={"file": ("chunk.wav", _wav(), "audio/wav")})
    assert upload(MEETING_ID + 1).status_code == 404
    assert not storage.blobs
    uploaded = upload(MEETING_ID)
    assert uploaded.status_code == 200
    assert uploaded.json()["speaker_timeline"] == "stored"
    rid = uploaded.json()["recording_id"]
    timeline = client.get(f"/recordings/{rid}/speaker-timeline", headers={"x-user-id": str(USER)})
    assert timeline.status_code == 200
    assert timeline.json()["intervals"] == part()["intervals"]


async def test_deployed_receiver_deletes_timeline_with_recording_and_preserves_other_sessions():
    # The image workflow assembles this feature onto v0.12.27, which owns the deletion API.
    # The older bot-fork baseline does not contain that module.
    pytest.importorskip("meeting_api.recordings.deletion")
    repo, storage = _seeded()
    uploaded = await send(repo, storage, 0, part(), final=True)
    rid = uploaded["recording_id"]
    repo._meetings[MEETING_ID]["status"] = "completed"
    unrelated = f"recordings/{USER}/999999/other-session/speaker-timeline/000000.json"
    await storage.upload(unrelated, b"unrelated", content_type="application/json")
    client = _client_for(repo, storage)
    assert client.delete(f"/recordings/{rid}", headers={"x-user-id": str(USER + 1)}).status_code == 404
    assert await read_timeline(storage, session_uid=SESSION_UID, owner=USER, recording_id=rid)
    assert client.delete(f"/recordings/{rid}", headers={"x-user-id": str(USER)}).status_code == 200
    assert storage.blobs == {unrelated: b"unrelated"}
    assert client.get(f"/recordings/{rid}/speaker-timeline", headers={"x-user-id": str(USER)}).status_code == 404
