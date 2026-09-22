"""Durable, owner-scoped attributed-audio.v1 ledger and object adapter."""
from __future__ import annotations

import hashlib
import math
from typing import Optional

from .service import SessionNotFound

MAX_ATTRIBUTED_AUDIO_BYTES = 32 * 1024 * 1024
# Browser callbacks are timestamped on a scheduling clock while PCM is sample-clocked. The public
# attributed-audio.v1 contract admits callbacks separated by at most this much scheduling time;
# a larger gap is represented by a new range.
MAX_CALLBACK_GAP_MS = 250
_IMMUTABLE = (
    "version", "meeting_id", "sequence", "idempotency_key", "speaker_key", "speaker_name",
    "channel", "turn_generation", "attribution", "clock_origin_ms", "start_ms", "end_ms",
    "audio_duration_ms", "codec", "sample_rate", "channels", "byte_count", "sha256",
)


class AttributedConflict(Exception):
    pass


def _manifest(meeting_id: int, prior: Optional[dict] = None) -> dict:
    value = dict(prior or {})
    value.setdefault("version", 1)
    value.setdefault("meeting_id", str(meeting_id))
    value.setdefault("clock_origin", "first_admitted_capture_epoch_ms")
    # A closed silent meeting has no first captured frame.  Version 1 represents that explicit
    # no-capture origin as numeric zero, never JSON null (which violates the published schema).
    if value.get("clock_origin_ms") is None:
        value["clock_origin_ms"] = 0
    value.setdefault("state", "open")
    value.setdefault("ranges", [])
    return value


def _safe_int(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    return value


def _safe_number(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return float(value)


def _validate(data: dict, body: Optional[bytes] = None) -> None:
    if data.get("version") != 1 or data.get("codec") != "pcm_f32le":
        raise AttributedConflict("unsupported attributed-audio version or codec")
    for key in ("sequence", "channel", "turn_generation", "sample_rate", "channels", "byte_count"):
        _safe_int(data.get(key), key)
    if data["sequence"] < 0 or data["channel"] < 0 or data["turn_generation"] < 1:
        raise AttributedConflict("invalid attributed range identity")
    if data["sample_rate"] < 1 or data["channels"] != 1:
        raise AttributedConflict("invalid attributed PCM dimensions")
    if data["byte_count"] > MAX_ATTRIBUTED_AUDIO_BYTES or data["byte_count"] % 4:
        raise AttributedConflict("invalid attributed PCM body size")
    if body is not None and data["byte_count"] != len(body):
        raise AttributedConflict("invalid attributed PCM dimensions")
    if body is not None and (len(body) > MAX_ATTRIBUTED_AUDIO_BYTES or len(body) % 4):
        raise AttributedConflict("invalid attributed PCM body size")
    start, end, origin = (_safe_number(data.get(k), k) for k in ("start_ms", "end_ms", "clock_origin_ms"))
    if start < 0 or end < start or origin < 0:
        raise AttributedConflict("invalid attributed PCM clock")
    audio_duration = _safe_number(data.get("audio_duration_ms"), "audio_duration_ms")
    wall_span = end - start
    if audio_duration < 0 or abs(wall_span - audio_duration) > MAX_CALLBACK_GAP_MS + 1000 / data["sample_rate"]:
        raise AttributedConflict("attributed PCM wall span does not match the sample clock")
    # PCM f32le is one 4-byte sample; validate sample time, not wall placement gaps.
    expected = audio_duration * data["sample_rate"] * data["channels"] * 4 / 1000
    if abs(expected - data["byte_count"]) > 4:
        raise AttributedConflict("attributed PCM duration does not match byte count")
    attribution = data.get("attribution")
    if not isinstance(attribution, dict) or attribution.get("source") not in ("glow-bound", "provisional", "unresolved"):
        raise AttributedConflict("invalid attribution provenance")
    confidence = _safe_number(attribution.get("confidence"), "attribution confidence")
    if not 0 <= confidence <= 1 or not isinstance(data.get("speaker_key"), str) or not data["speaker_key"]:
        raise AttributedConflict("invalid attributed speaker identity")
    name = data.get("speaker_name")
    if not isinstance(name, str) or (attribution["source"] == "glow-bound" and not name) or (attribution["source"] == "unresolved" and name):
        raise AttributedConflict("invalid attributed speaker name/provenance")
    digest = data.get("sha256")
    if not isinstance(digest, str) or len(digest) != 64:
        raise AttributedConflict("attributed PCM checksum does not match body")
    if body is not None and digest != hashlib.sha256(body).hexdigest():
        raise AttributedConflict("attributed PCM checksum does not match body")
    if not isinstance(data.get("idempotency_key"), str) or not data["idempotency_key"]:
        raise AttributedConflict("invalid attributed idempotency key")


def _same_range(existing: dict, incoming: dict) -> bool:
    return all(existing.get(key) == incoming.get(key) for key in _IMMUTABLE)


async def _session_meeting(repo, *, token_meeting_id: Optional[int], session_uid: str) -> int:
    session = await repo.find_session(session_uid)
    if session is None:
        raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id:
        raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")
    return meeting_id


async def reserve_attributed_range(repo, *, token_meeting_id: Optional[int], session_uid: str, range_data: dict) -> dict:
    """Durably reserve every immutable field before the bot offers bytes."""
    meeting_id = await _session_meeting(repo, token_meeting_id=token_meeting_id, session_uid=session_uid)
    if range_data.get("meeting_id") != str(meeting_id):
        raise AttributedConflict("attributed range meeting_id does not match the session")
    _validate(range_data)
    incoming = dict(range_data)
    incoming["meeting_id"] = str(meeting_id)
    incoming["state"] = "sealed"
    incoming.pop("path", None); incoming.pop("storage_path", None)
    owner = await repo.owner_of(meeting_id)
    # This candidate key is durable before bytes leave the bot.  A crash after the object PUT and
    # before its acknowledgement is therefore still visible to deletion/reconciliation.
    object_key = f"attributed-audio/{owner or 0}/{meeting_id}/{session_uid}/{incoming['sequence']:06d}-{incoming['sha256']}.pcm"

    def reserve(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        if deletion.get("state") in ("pending", "completed"):
            raise AttributedConflict("attributed audio artifact deletion is in progress")
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        if manifest["state"] != "open":
            old = next((r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"]), None)
            if old and _same_range(old, incoming): return data_json, (dict(old), False)
            raise AttributedConflict("attributed audio manifest is closed")
        old = next((r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"]), None)
        if old:
            if not _same_range(old, incoming): raise AttributedConflict("idempotency key metadata conflicts with reservation")
            return data_json, (dict(old), False)
        if any(r.get("sequence") == incoming["sequence"] for r in manifest["ranges"]):
            raise AttributedConflict("attributed sequence is already reserved")
        # Numeric zero is the closed-empty sentinel.  An open manifest with no ranges has not
        # admitted its first frame yet, so its first reservation replaces that sentinel.
        if not manifest["ranges"] and manifest["clock_origin_ms"] == 0:
            manifest["clock_origin_ms"] = incoming["clock_origin_ms"]
        if manifest["clock_origin_ms"] != incoming["clock_origin_ms"]:
            raise AttributedConflict("attributed clock origin conflicts with manifest")
        incoming["path"] = f"/meetings/{meeting_id}/attributed-audio/ranges/{incoming['sequence']}"
        incoming["storage_path"] = object_key
        manifest["ranges"].append(incoming)
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, (dict(incoming), True)

    reserved, _ = await repo.mutate_meeting_data(meeting_id, reserve)
    return reserved


async def _retain_uncertain_upload_cleanup(repo, *, meeting_id: int, incoming: dict, key: str) -> None:
    """Keep the deterministic key reachable when a PUT's outcome cannot be known.

    Object stores may finish a PUT and still fail to acknowledge it to this process.  Once a
    deletion tombstone exists, the only safe outcome is to retain the key in a new cleanup
    generation; a later deletion owns the retry rather than guessing that no bytes were written.
    """
    def retain(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        found = next((r for r in manifest["ranges"]
                      if r.get("idempotency_key") == incoming["idempotency_key"]), None)
        if found is None:
            found = dict(incoming)
            found["state"] = "failed"
            found["path"] = f"/meetings/{meeting_id}/attributed-audio/ranges/{incoming['sequence']}"
            manifest["ranges"].append(found)
        found["storage_path"] = key
        manifest["state"] = "closed"
        next_data = dict(data_json)
        next_data["attributed_audio_manifest"] = manifest
        # This key was not necessarily in a deletion's storage snapshot.  Advance the fence even
        # when the manifest happens to compare equal, so a stale finalizer cannot erase its only
        # cleanup evidence.
        if deletion.get("state") in ("pending", "completed"):
            retrying = dict(deletion)
            retrying["state"] = "pending"
            retrying["cleanup_version"] = int(deletion.get("cleanup_version") or 0) + 1
            retrying.pop("completed_at", None)
            next_data["artifact_deletion"] = retrying
        legacy = deletion.get("legacy_recording") if isinstance(deletion, dict) else None
        if deletion.get("state") == "completed" and isinstance(legacy, dict):
            rows = list(next_data.get("recordings") or [])
            if not any(row.get("id") == legacy.get("id") for row in rows):
                rows.append({**legacy, "deletion_pending": True})
            next_data["recordings"] = rows
        return next_data, None

    await repo.mutate_meeting_data(meeting_id, retain)


async def upload_reserved_attributed_range(repo, storage, *, token_meeting_id: Optional[int], session_uid: str, range_data: dict, data: bytes) -> dict:
    """Upload only against a pre-existing immutable reservation; upload/fail never regress uploaded."""
    meeting_id = await _session_meeting(repo, token_meeting_id=token_meeting_id, session_uid=session_uid)
    if range_data.get("meeting_id") != str(meeting_id):
        raise AttributedConflict("attributed range meeting_id does not match the session")
    _validate(range_data, data)
    incoming = dict(range_data); incoming.pop("state", None); incoming.pop("path", None); incoming.pop("storage_path", None)

    def find_reserved(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        if deletion.get("state") in ("pending", "completed"):
            raise AttributedConflict("attributed audio artifact deletion is in progress")
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        found = next((r for r in manifest["ranges"] if r.get("idempotency_key") == incoming.get("idempotency_key")), None)
        # A completed PUT owns its deterministic key even after close.  A duplicate HTTP request
        # is acknowledgement-only: touching storage here could overwrite or compensating-delete
        # the object named by the durable uploaded row.
        if found and _same_range(found, incoming) and found.get("state") == "uploaded":
            return data_json, dict(found)
        if manifest.get("state") != "open" or not found or not _same_range(found, incoming):
            raise AttributedConflict("attributed range was not durably reserved")
        if found.get("state") == "failed":
            raise AttributedConflict("attributed range has a terminal failed outcome")
        return data_json, dict(found)
    reserved = (await repo.mutate_meeting_data(meeting_id, find_reserved))
    if reserved.get("state") == "uploaded": return reserved
    key = reserved.get("storage_path")
    if not isinstance(key, str):
        raise AttributedConflict("attributed reservation omitted deterministic object key")
    try:
        await storage.upload(key, data, content_type="application/octet-stream")
    except Exception:
        def fail(data_json):
            deletion = data_json.get("artifact_deletion") or {}
            if deletion.get("state") in ("pending", "completed"):
                return data_json, True
            manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
            found = next(r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"])
            # A concurrent successful retry is final; a failed retry must not downgrade it.
            if found.get("state") != "uploaded": found["state"] = "failed"
            next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
            return next_data, False
        deletion_won = await repo.mutate_meeting_data(meeting_id, fail)
        # A raised PUT is ambiguous: the storage backend can have written the deterministic key
        # before its acknowledgement failed.  Do not discard that key merely because a deletion
        # raced it; retain a fenced cleanup obligation for the deletion retry.
        if deletion_won:
            await _retain_uncertain_upload_cleanup(repo, meeting_id=meeting_id, incoming=incoming, key=key)
        raise

    def acknowledge(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        if deletion.get("state") in ("pending", "completed"):
            raise AttributedConflict("attributed audio artifact deletion is in progress")
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        # Another request can finish this deterministic PUT and close the manifest while this
        # request is still in storage. The matching uploaded row is the durable acknowledgement;
        # never compensate by deleting the object it names.
        found = next((r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"]), None)
        if found and _same_range(found, incoming) and found.get("state") == "uploaded":
            return data_json, dict(found)
        if manifest.get("state") != "open":
            raise AttributedConflict("attributed audio manifest is closed or deleted")
        if not found or not _same_range(found, incoming) or found.get("state") == "failed":
            raise AttributedConflict("attributed range cannot be acknowledged")
        found["state"] = "uploaded"; found["storage_path"] = key
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, dict(found)
    try:
        return await repo.mutate_meeting_data(meeting_id, acknowledge)
    except Exception:
        # A deletion/close can win after the object write. It must not leave a late upload
        # orphaned merely because its ledger acknowledgement was fenced out.
        try:
            await storage.delete(key)
        except Exception:
            await _retain_uncertain_upload_cleanup(repo, meeting_id=meeting_id, incoming=incoming, key=key)
        raise


async def fail_reserved_attributed_range(repo, *, token_meeting_id: Optional[int], session_uid: str, range_data: dict) -> dict:
    meeting_id = await _session_meeting(repo, token_meeting_id=token_meeting_id, session_uid=session_uid)
    if range_data.get("meeting_id") != str(meeting_id):
        raise AttributedConflict("attributed range meeting_id does not match the session")
    _validate(range_data)
    incoming = dict(range_data); incoming.pop("state", None); incoming.pop("path", None); incoming.pop("storage_path", None)
    def fail(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        if deletion.get("state") in ("pending", "completed"):
            raise AttributedConflict("attributed audio artifact deletion is in progress")
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        found = next((r for r in manifest["ranges"] if r.get("idempotency_key") == incoming.get("idempotency_key")), None)
        if not found or not _same_range(found, incoming):
            raise AttributedConflict("attributed range was not durably reserved")
        if manifest.get("state") != "open" and found.get("state") != "failed":
            raise AttributedConflict("attributed audio manifest is closed")
        # The reservation owns this deterministic key even after a restart has no PCM to retry.
        # Deletion/reconciliation need it to remove a PUT that crashed before acknowledgement.
        if found.get("state") != "uploaded": found["state"] = "failed"
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, dict(found)
    return await repo.mutate_meeting_data(meeting_id, fail)


async def attributed_manifest_for_session(repo, *, token_meeting_id: Optional[int], session_uid: str) -> dict:
    meeting_id = await _session_meeting(repo, token_meeting_id=token_meeting_id, session_uid=session_uid)
    def read(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        if deletion.get("state") in ("pending", "completed"):
            raise AttributedConflict("attributed audio artifact deletion is in progress")
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        return data_json, public_manifest(manifest)
    return await repo.mutate_meeting_data(meeting_id, read)


async def upload_attributed_range(repo, storage, *, token_meeting_id: Optional[int], session_uid: str, range_data: dict, data: bytes) -> dict:
    """Compatibility composition for callers outside the explicit HTTP protocol."""
    await reserve_attributed_range(repo, token_meeting_id=token_meeting_id, session_uid=session_uid, range_data=range_data)
    return await upload_reserved_attributed_range(repo, storage, token_meeting_id=token_meeting_id, session_uid=session_uid, range_data=range_data, data=data)


async def close_attributed_manifest(repo, *, token_meeting_id: Optional[int], session_uid: str, expected_sequences: Optional[list[int]] = None) -> dict:
    session = await repo.find_session(session_uid)
    if session is None: raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id: raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")
    expected = set(expected_sequences or [])
    if any(not isinstance(value, int) or value < 0 for value in expected): raise AttributedConflict("invalid admitted sequence ledger")
    def close(data_json):
        deletion = data_json.get("artifact_deletion") or {}
        if deletion.get("state") in ("pending", "completed"):
            raise AttributedConflict("attributed audio artifact deletion is in progress")
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        present = {r.get("sequence") for r in manifest["ranges"]}
        if not expected.issubset(present): raise AttributedConflict("server ledger omits client-admitted ranges")
        if manifest["state"] == "closed": return data_json, manifest
        if any(r.get("state") not in ("uploaded", "failed") for r in manifest["ranges"]):
            raise AttributedConflict("attributed audio uploads have not reached a durable outcome")
        manifest["state"] = "closed"; next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, manifest
    return await repo.mutate_meeting_data(meeting_id, close)


def public_manifest(manifest: dict) -> dict:
    """Strip storage keys; callers get only owner-authorized relative retrieval paths."""
    clean = {key: value for key, value in manifest.items() if key != "ranges"}
    clean["ranges"] = [{key: value for key, value in row.items() if key != "storage_path"} for row in manifest.get("ranges", [])]
    return clean


async def attributed_manifest_for_owner(repo, *, user_id: int, meeting_id: int) -> dict:
    artifact = await repo.attributed_artifacts_for_owner(user_id, meeting_id)
    if artifact and (artifact.get("artifact_deletion") or {}).get("state") in ("pending", "completed"):
        raise SessionNotFound("attributed audio manifest not found")
    manifest = artifact.get("manifest") if artifact else None
    if not manifest: raise SessionNotFound("attributed audio manifest not found")
    return public_manifest(manifest)


async def attributed_range_for_owner(repo, storage, *, user_id: int, meeting_id: int, sequence: int) -> bytes:
    artifact = await repo.attributed_artifacts_for_owner(user_id, meeting_id)
    if artifact and (artifact.get("artifact_deletion") or {}).get("state") in ("pending", "completed"):
        raise SessionNotFound("attributed audio range not found")
    manifest = artifact.get("manifest") if artifact else None
    if not manifest or manifest.get("state") != "closed": raise SessionNotFound("attributed audio range not found")
    value = next((r for r in manifest.get("ranges", []) if r.get("sequence") == sequence and r.get("state") == "uploaded"), None)
    path = value.get("storage_path") if isinstance(value, dict) else None
    if not isinstance(path, str) or not path.startswith("attributed-audio/"): raise SessionNotFound("attributed audio range not found")
    return await storage.get(path)
