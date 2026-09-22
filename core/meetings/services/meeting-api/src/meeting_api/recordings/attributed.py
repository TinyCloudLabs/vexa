"""Canonical attributed PCM ranges, using the recordings JSONB row lock and object store.

This is deliberately not a second blob service.  The bot authenticates exactly as it does for
recording chunks; metadata lives on the meeting row and bytes use the existing Storage port.
"""
from __future__ import annotations

import hashlib
from typing import Optional

from .service import SessionNotFound


class AttributedConflict(Exception):
    pass


def _manifest(meeting_id: int, prior: Optional[dict] = None) -> dict:
    value = dict(prior or {})
    value.setdefault("version", 1)
    value.setdefault("meeting_id", str(meeting_id))
    value.setdefault("clock_origin", "capture_epoch_ms")
    value.setdefault("state", "open")
    value.setdefault("ranges", [])
    return value


def _same_range(existing: dict, incoming: dict) -> bool:
    return (existing.get("idempotency_key") == incoming.get("idempotency_key")
            and existing.get("sha256") == incoming.get("sha256")
            and existing.get("byte_count") == incoming.get("byte_count"))


def _safe_int(value, name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    return int(value)


async def upload_attributed_range(repo, storage, *, token_meeting_id: Optional[int],
                                  session_uid: str, range_data: dict, data: bytes) -> dict:
    """Reserve metadata under the meeting row lock, then write one immutable PCM object.

    A retry with the same idempotency/checksum observes the same range.  A changed body under an
    existing idempotency key is a conflict, never an overwrite.
    """
    session = await repo.find_session(session_uid)
    if session is None:
        raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id:
        raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")
    checksum = hashlib.sha256(data).hexdigest()
    if range_data.get("sha256") != checksum or _safe_int(range_data.get("byte_count"), "byte_count") != len(data):
        raise AttributedConflict("attributed PCM checksum or byte_count does not match body")
    sequence = _safe_int(range_data.get("sequence"), "sequence")
    if sequence < 0 or not isinstance(range_data.get("idempotency_key"), str):
        raise AttributedConflict("invalid attributed range identity")
    owner = await repo.owner_of(meeting_id)

    incoming = dict(range_data)
    incoming["meeting_id"] = str(meeting_id)
    incoming["state"] = "sealed"
    incoming.pop("path", None)

    def reserve(data_json):
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        old = next((r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"]), None)
        if old:
            if not _same_range(old, incoming):
                raise AttributedConflict("idempotency key already reserved with different PCM")
            return data_json, (dict(old), False)
        if manifest["state"] != "open":
            raise AttributedConflict("attributed audio manifest is closed")
        if sequence != len(manifest["ranges"]):
            raise AttributedConflict("attributed range sequence was not reserved in order")
        incoming["path"] = f"/meetings/{meeting_id}/attributed-audio/ranges/{sequence}"
        manifest["ranges"].append(incoming)
        next_data = dict(data_json)
        next_data["attributed_audio_manifest"] = manifest
        return next_data, (dict(incoming), True)

    reserved, newly_reserved = await repo.mutate_meeting_data(meeting_id, reserve)
    if not newly_reserved and reserved.get("state") == "uploaded":
        return reserved
    key = f"attributed-audio/{owner or 0}/{meeting_id}/{session_uid}/{sequence:06d}-{checksum}.pcm"
    try:
        await storage.upload(key, data, content_type="application/octet-stream")
    except Exception:
        def fail(data_json):
            manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
            for value in manifest["ranges"]:
                if value.get("idempotency_key") == incoming["idempotency_key"]:
                    value["state"] = "failed"
                    value.pop("storage_path", None)
            next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
            return next_data, None
        await repo.mutate_meeting_data(meeting_id, fail)
        raise

    def admit(data_json):
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        found = next(r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"])
        found["state"] = "uploaded"
        found["storage_path"] = key
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, dict(found)
    return await repo.mutate_meeting_data(meeting_id, admit)


async def close_attributed_manifest(repo, *, token_meeting_id: Optional[int], session_uid: str) -> dict:
    session = await repo.find_session(session_uid)
    if session is None:
        raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id:
        raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")

    def close(data_json):
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        if manifest["state"] == "closed":
            return data_json, manifest
        if any(r.get("state") not in ("uploaded", "failed") for r in manifest["ranges"]):
            raise AttributedConflict("attributed audio uploads have not reached a durable outcome")
        manifest["state"] = "closed"
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, manifest
    return await repo.mutate_meeting_data(meeting_id, close)


async def attributed_range_for_owner(repo, storage, *, user_id: int, meeting_id: int, sequence: int) -> bytes:
    manifest = await repo.attributed_manifest_for_owner(user_id, meeting_id)
    if not manifest or manifest.get("state") != "closed":
        raise SessionNotFound("attributed audio range not found")
    ranges = manifest.get("ranges") if isinstance(manifest.get("ranges"), list) else []
    value = next((r for r in ranges if r.get("sequence") == sequence and r.get("state") == "uploaded"), None)
    path = value.get("storage_path") if isinstance(value, dict) else None
    if not isinstance(path, str) or not path.startswith("attributed-audio/"):
        raise SessionNotFound("attributed audio range not found")
    return await storage.get(path)
