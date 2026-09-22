"""Owner-scoped recording-object deletion primitives.

Object storage is erased before JSONB metadata is removed.  That ordering is deliberate: if an
S3/MinIO delete fails, the persisted paths remain addressable and the same request can be retried.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .ports import RecordingRepo, Storage


class MeetingNotTerminal(Exception):
    """The recording exists, but its meeting lifecycle may still produce more artifacts."""


def _artifact_deletion(state: str, prior: Optional[dict] = None) -> dict:
    """The shared tombstone/fence shape used by every completed-artifact delete path."""
    value = {
        "state": state,
        "scope": "primary_transcript_and_recording_storage",
        "backup_residuals": "expire_under_deployment_retention_policy",
    }
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if state == "pending":
        value["requested_at"] = (prior or {}).get("requested_at") or now
    else:
        value["completed_at"] = now
    return value


def _recording_prefix(recording: dict) -> Optional[str]:
    """Return the canonical key prefix for every chunk/master belonging to ``recording``."""
    user_id = recording.get("user_id")
    recording_id = recording.get("id")
    session_uid = recording.get("session_uid")
    if user_id is None or recording_id is None or not session_uid:
        return None
    return f"recordings/{user_id}/{recording_id}/{session_uid}/"


def _owner_prefix(recording: dict) -> Optional[str]:
    """The owner's whole object namespace — the boundary a deletion may never reach past."""
    user_id = recording.get("user_id")
    return f"recordings/{user_id}/" if user_id is not None else None


async def recording_object_keys(storage: Storage, recording: dict) -> list[str]:
    """Discover every current object plus any explicitly persisted legacy/master path."""
    keys: set[str] = set()
    prefix = _recording_prefix(recording)
    if prefix:
        keys.update(await storage.list(prefix))
    owner_prefix = _owner_prefix(recording)
    for media_file in recording.get("media_files") or []:
        path = media_file.get("storage_path") if isinstance(media_file, dict) else None
        # A persisted path is data, not authority. Every writer derives it from
        # ``chunk_storage_key(user_id=owner, ...)``, so it already lies inside the owner's namespace
        # and this rejects nothing today. It is what keeps the blast radius owner-bounded if a
        # ``storage_path`` ever becomes writable from a request, or a backend normalises ``..``:
        # the worst such a path could then do is name another object of the SAME owner.
        if path and owner_prefix and path.startswith(owner_prefix):
            keys.add(path)
    return sorted(keys)


async def delete_recording_objects(storage: Storage, recording: dict) -> list[str]:
    """Delete all discoverable objects idempotently and return the keys attempted."""
    keys = await recording_object_keys(storage, recording)
    for key in keys:
        await storage.delete(key)
    return keys


async def delete_attributed_objects(storage: Storage, manifest: Optional[dict], *, user_id: int, meeting_id: int) -> list[str]:
    """Delete only the attributed keys the owner-scoped durable ledger names."""
    prefix = f"attributed-audio/{user_id}/{meeting_id}/"
    keys = sorted({row.get("storage_path") for row in (manifest or {}).get("ranges", [])
                   if isinstance(row, dict) and isinstance(row.get("storage_path"), str)
                   and row["storage_path"].startswith(prefix)})
    for key in keys:
        await storage.delete(key)
    return keys


async def delete_owned_recording(
    repo: RecordingRepo, storage: Storage, *, user_id: int, recording_id: int
) -> Optional[dict]:
    """Delete one caller-owned recording; unknown and unowned ids are indistinguishable.

    Storage deletion completes before the atomic JSONB mutation.  A storage exception therefore
    leaves the recording metadata intact for a safe retry.
    """
    recording = await repo.prepare_recording_deletion(user_id, recording_id)
    if recording is None:
        return None
    if recording.get("error") == "conflict":
        raise MeetingNotTerminal

    meeting_id = int(recording["meeting_id"])
    # This legacy endpoint deletes the same meeting artifacts as the newer completed-artifact
    # path. Publish the durable write fence before touching storage so an old bot token cannot
    # reserve, upload, or recreate attributed PCM while this delete is in flight.
    def _prepare_artifact(data: dict):
        next_data = dict(data)
        prior = next_data.get("artifact_deletion")
        next_data["artifact_deletion"] = _artifact_deletion("pending", prior if isinstance(prior, dict) else None)
        return next_data, next_data.get("attributed_audio_manifest")

    manifest = await repo.mutate_meeting_data(meeting_id, _prepare_artifact)
    deleted_keys = await delete_recording_objects(storage, recording)
    # Attributed PCM belongs to the same completed meeting artifact. Delete objects first so a
    # storage fault leaves its manifest available for retry rather than lying about cleanup.
    attributed_keys = await delete_attributed_objects(storage, manifest, user_id=user_id, meeting_id=meeting_id)

    # Complete only after every primary object was removed, and atomically remove the durable
    # cleanup ledger with the recording metadata. A failed delete leaves pending + storage paths
    # intact for the same endpoint to retry.
    def _complete_artifact(data: dict):
        next_data = dict(data)
        next_data["recordings"] = [r for r in next_data.get("recordings", []) if r.get("id") != recording_id]
        next_data.pop("attributed_audio_manifest", None)
        next_data["artifact_deletion"] = _artifact_deletion("completed")
        return next_data, None

    await repo.mutate_meeting_data(meeting_id, _complete_artifact)
    return {
        "status": "deleted",
        "recording_id": recording_id,
        "meeting_id": meeting_id,
        "objects_deleted": len(deleted_keys) + len(attributed_keys),
        "scope": "primary_object_storage",
    }
