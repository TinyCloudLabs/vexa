"""#116 — completed meeting transcript + recording-object erasure."""
from __future__ import annotations

from fastapi.testclient import TestClient

from meeting_api import create_app
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.recordings.fakes import InMemoryStorage


OWNER = 7
OTHER = 8
MEETING_ID = 41
RECORDING_ID = 9001
PREFIX = f"recordings/{OWNER}/{RECORDING_ID}/sess-41/audio/"


def _recording() -> dict:
    return {
        "id": RECORDING_ID,
        "meeting_id": MEETING_ID,
        "user_id": OWNER,
        "session_uid": "sess-41",
        "status": "completed",
        "media_files": [{
            "id": 22,
            "type": "audio",
            "format": "wav",
            "storage_path": f"{PREFIX}master.wav",
        }],
    }


def _fixture(*, status: str = "completed", storage_cls=InMemoryStorage):
    store = InMemoryTranscriptStore()
    store.seed_meeting(
        meeting_id=MEETING_ID,
        user_id=OWNER,
        platform="google_meet",
        native_meeting_id="private-room",
        status=status,
        data={
            "recordings": [_recording()],
            "attributed_audio_manifest": {
                "state": "closed", "ranges": [{
                    "state": "uploaded",
                    "storage_path": f"attributed-audio/{OWNER}/{MEETING_ID}/sess-41/000000-a.pcm",
                }],
            },
            "processed": {"views": [{"doc": {"notes": ["derived"]}}]},
            "notes": "derived summary",
            "share_grants": [{"id": "share"}],
            "transcript_viewers": [OTHER],
        },
        segments=[{
            "segment_id": "s1", "start": 0, "end": 1,
            "text": "confidential", "language": "en",
        }],
    )
    storage = storage_cls()
    storage.blobs[f"{PREFIX}000000.wav"] = b"chunk"
    storage.blobs[f"{PREFIX}master.wav"] = b"master"
    storage.blobs[f"attributed-audio/{OWNER}/{MEETING_ID}/sess-41/000000-a.pcm"] = b"pcm"
    return store, storage, TestClient(
        create_app(transcript_store=store, storage=storage),
        raise_server_exceptions=False,
    )


def test_owner_deletes_completed_artifacts_but_terminal_meeting_row_survives():
    store, storage, client = _fixture()

    response = client.delete(
        f"/meetings/{MEETING_ID}", headers={"x-user-id": str(OWNER)}
    )
    assert response.status_code == 204
    assert storage.blobs == {}
    assert client.get(
        "/transcripts/google_meet/private-room", headers={"x-user-id": str(OWNER)}
    ).status_code == 404

    meeting = store._meetings[MEETING_ID]
    assert meeting["status"] == "completed", "terminal lifecycle evidence is retained"
    assert meeting["segments"] == {}
    assert "recordings" not in meeting["data"]
    assert "attributed_audio_manifest" not in meeting["data"]
    assert "processed" not in meeting["data"]
    assert "notes" not in meeting["data"]
    assert meeting["data"]["artifact_deletion"]["backup_residuals"] == (
        "expire_under_deployment_retention_policy"
    )


def test_native_meeting_delete_erases_attributed_only_artifacts_too():
    store, storage, client = _fixture()
    # The native-key route is a separate public front door but shares the same deletion plan.
    response = client.delete("/meetings/google_meet/private-room", headers={"x-user-id": str(OWNER)})
    assert response.status_code == 200
    assert storage.blobs == {}
    assert "attributed_audio_manifest" not in store._meetings[MEETING_ID]["data"]
    assert client.get("/transcripts/google_meet/private-room", headers={"x-user-id": str(OWNER)}).status_code == 404


def test_non_owner_gets_indistinguishable_404_and_cannot_delete_any_artifact():
    store, storage, client = _fixture()

    response = client.delete(
        f"/meetings/{MEETING_ID}", headers={"x-user-id": str(OTHER)}
    )
    assert response.status_code == 404
    assert sorted(storage.blobs) == [
        f"attributed-audio/{OWNER}/{MEETING_ID}/sess-41/000000-a.pcm",
        f"{PREFIX}000000.wav", f"{PREFIX}master.wav",
    ]
    assert store._meetings[MEETING_ID]["segments"]["s1"]["text"] == "confidential"


def test_storage_failure_preserves_paths_and_transcript_for_retry():
    class FailsOnceStorage(InMemoryStorage):
        def __init__(self):
            super().__init__()
            self.fail = True

        async def delete(self, key: str) -> None:
            if self.fail:
                self.fail = False
                raise RuntimeError("injected object-store failure")
            await super().delete(key)

    store, storage, client = _fixture(storage_cls=FailsOnceStorage)

    first = client.delete(f"/meetings/{MEETING_ID}", headers={"x-user-id": str(OWNER)})
    assert first.status_code == 500
    assert store._meetings[MEETING_ID]["data"]["recordings"][0]["id"] == RECORDING_ID
    assert store._meetings[MEETING_ID]["data"]["artifact_deletion"]["state"] == "pending"
    assert client.get(
        "/transcripts/google_meet/private-room", headers={"x-user-id": str(OWNER)}
    ).status_code == 200

    retry = client.delete(f"/meetings/{MEETING_ID}", headers={"x-user-id": str(OWNER)})
    assert retry.status_code == 204
    assert storage.blobs == {}
    assert "recordings" not in store._meetings[MEETING_ID]["data"]
    assert store._meetings[MEETING_ID]["data"]["artifact_deletion"]["state"] == "completed"


def test_completed_artifact_delete_is_idempotent_and_active_lifecycle_is_not_deleted():
    store, storage, client = _fixture()
    headers = {"x-user-id": str(OWNER)}
    assert client.delete(f"/meetings/{MEETING_ID}", headers=headers).status_code == 204
    assert client.delete(f"/meetings/{MEETING_ID}", headers=headers).status_code == 204

    active_store, active_storage, active_client = _fixture(status="active")
    response = active_client.delete(f"/meetings/{MEETING_ID}", headers=headers)
    assert response.status_code == 409
    assert active_store._meetings[MEETING_ID]["status"] == "active"
    assert active_storage.blobs


def test_completed_delete_generation_fences_an_equal_manifest_snapshot():
    """A late deterministic PUT can renew cleanup without changing the manifest value itself."""
    import asyncio

    store, _storage, _client = _fixture()
    plan = asyncio.run(store.prepare_completed_artifact_deletion(OWNER, MEETING_ID))
    manifest = store._meetings[MEETING_ID]["data"]["attributed_audio_manifest"]
    # Model the late PUT's durable cleanup restoration: its manifest is byte-for-byte equal to the
    # snapshot, but its cleanup generation has advanced after the storage snapshot was taken.
    store._meetings[MEETING_ID]["data"]["attributed_audio_manifest"] = manifest
    store._meetings[MEETING_ID]["data"]["artifact_deletion"] = {
        **store._meetings[MEETING_ID]["data"]["artifact_deletion"],
        "state": "pending",
        "cleanup_version": plan["cleanup_version"] + 1,
    }
    assert asyncio.run(store.finalize_completed_artifact_deletion(OWNER, MEETING_ID, plan)) is False
    retained = store._meetings[MEETING_ID]["data"]
    assert retained["attributed_audio_manifest"] == manifest
    assert retained["artifact_deletion"]["state"] == "pending"


def test_generic_delete_retries_late_put_cleanup_after_a_stale_snapshot():
    """The completed-meeting front door retains and then cleans a late deterministic object."""
    import asyncio

    class LatePutStore(InMemoryTranscriptStore):
        inject_late_put = True

        async def finalize_completed_artifact_deletion(self, user_id, meeting_id, cleanup_plan=None):
            if self.inject_late_put:
                self.inject_late_put = False
                data = dict(self._meetings[meeting_id]["data"])
                data["attributed_audio_manifest"] = {
                    **cleanup_plan["attributed_audio_manifest"],
                    "ranges": [{"storage_path": f"attributed-audio/{OWNER}/{MEETING_ID}/late/000001.pcm", "state": "failed"}],
                }
                data["artifact_deletion"] = {
                    **data["artifact_deletion"], "state": "pending",
                    "cleanup_version": cleanup_plan["cleanup_version"] + 1,
                }
                self._meetings[meeting_id]["data"] = data
                storage.blobs[f"attributed-audio/{OWNER}/{MEETING_ID}/late/000001.pcm"] = b"late"
            return await super().finalize_completed_artifact_deletion(user_id, meeting_id, cleanup_plan)

    store = LatePutStore()
    store.seed_meeting(
        meeting_id=MEETING_ID, user_id=OWNER, platform="google_meet", native_meeting_id="private-room",
        status="completed", data={"attributed_audio_manifest": {"state": "closed", "ranges": []}},
    )
    storage = InMemoryStorage()
    client = TestClient(create_app(transcript_store=store, storage=storage), raise_server_exceptions=False)
    headers = {"x-user-id": str(OWNER)}
    first = client.delete(f"/meetings/{MEETING_ID}", headers=headers)
    assert first.status_code == 409
    retained = store._meetings[MEETING_ID]["data"]
    assert retained["artifact_deletion"]["state"] == "pending"
    assert retained["artifact_deletion"]["cleanup_version"] == 2
    assert retained["attributed_audio_manifest"]["ranges"][0]["storage_path"].endswith("000001.pcm")
    assert storage.blobs[f"attributed-audio/{OWNER}/{MEETING_ID}/late/000001.pcm"] == b"late"

    # The owner retries the same generic endpoint; its new snapshot owns the restored key.
    assert client.delete(f"/meetings/{MEETING_ID}", headers=headers).status_code == 204
    assert storage.blobs == {}
    assert "attributed_audio_manifest" not in store._meetings[MEETING_ID]["data"]
