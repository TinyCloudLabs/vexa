"""Durable, owner-scoped attributed-audio.v1 ledger and object adapter."""
from __future__ import annotations

import hashlib
import math
from typing import Optional

from .service import SessionNotFound

MAX_ATTRIBUTED_AUDIO_BYTES = 32 * 1024 * 1024
_IMMUTABLE = (
    "version", "meeting_id", "sequence", "idempotency_key", "speaker_key", "speaker_name",
    "channel", "turn_generation", "attribution", "clock_origin_ms", "start_ms", "end_ms",
    "codec", "sample_rate", "channels", "byte_count", "sha256",
)


class AttributedConflict(Exception):
    pass


def _manifest(meeting_id: int, prior: Optional[dict] = None) -> dict:
    value = dict(prior or {})
    value.setdefault("version", 1)
    value.setdefault("meeting_id", str(meeting_id))
    value.setdefault("clock_origin", "first_admitted_capture_epoch_ms")
    value.setdefault("clock_origin_ms", None)
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


def _validate(data: dict, body: bytes) -> None:
    if data.get("version") != 1 or data.get("codec") != "pcm_f32le":
        raise AttributedConflict("unsupported attributed-audio version or codec")
    for key in ("sequence", "channel", "turn_generation", "sample_rate", "channels", "byte_count"):
        _safe_int(data.get(key), key)
    if data["sequence"] < 0 or data["channel"] < 0 or data["turn_generation"] < 1:
        raise AttributedConflict("invalid attributed range identity")
    if data["sample_rate"] < 1 or data["channels"] != 1 or data["byte_count"] != len(body):
        raise AttributedConflict("invalid attributed PCM dimensions")
    if len(body) > MAX_ATTRIBUTED_AUDIO_BYTES or len(body) % 4:
        raise AttributedConflict("invalid attributed PCM body size")
    start, end, origin = (_safe_number(data.get(k), k) for k in ("start_ms", "end_ms", "clock_origin_ms"))
    if start < 0 or end < start or origin < 0:
        raise AttributedConflict("invalid attributed PCM clock")
    # PCM f32le is one 4-byte sample; allow one sample of timestamp rounding only.
    expected = (end - start) * data["sample_rate"] * data["channels"] * 4 / 1000
    if abs(expected - len(body)) > 4:
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
    if not isinstance(digest, str) or digest != hashlib.sha256(body).hexdigest() or len(digest) != 64:
        raise AttributedConflict("attributed PCM checksum does not match body")
    if not isinstance(data.get("idempotency_key"), str) or not data["idempotency_key"]:
        raise AttributedConflict("invalid attributed idempotency key")


def _same_range(existing: dict, incoming: dict) -> bool:
    return all(existing.get(key) == incoming.get(key) for key in _IMMUTABLE)


async def upload_attributed_range(repo, storage, *, token_meeting_id: Optional[int], session_uid: str, range_data: dict, data: bytes) -> dict:
    """Reserve an immutable row under the meeting lock, then upload bytes without ordering assumptions."""
    session = await repo.find_session(session_uid)
    if session is None:
        raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id:
        raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")
    if range_data.get("meeting_id") != str(meeting_id):
        raise AttributedConflict("attributed range meeting_id does not match the session")
    _validate(range_data, data)
    incoming = dict(range_data)
    incoming["meeting_id"] = str(meeting_id)
    incoming["state"] = "sealed"
    incoming.pop("path", None); incoming.pop("storage_path", None)

    def reserve(data_json):
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
        if manifest["clock_origin_ms"] is None: manifest["clock_origin_ms"] = incoming["clock_origin_ms"]
        if manifest["clock_origin_ms"] != incoming["clock_origin_ms"]:
            raise AttributedConflict("attributed clock origin conflicts with manifest")
        incoming["path"] = f"/meetings/{meeting_id}/attributed-audio/ranges/{incoming['sequence']}"
        manifest["ranges"].append(incoming)
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, (dict(incoming), True)

    reserved, newly_reserved = await repo.mutate_meeting_data(meeting_id, reserve)
    if not newly_reserved and reserved.get("state") == "uploaded": return reserved
    owner = await repo.owner_of(meeting_id)
    key = f"attributed-audio/{owner or 0}/{meeting_id}/{session_uid}/{incoming['sequence']:06d}-{incoming['sha256']}.pcm"
    try:
        await storage.upload(key, data, content_type="application/octet-stream")
    except Exception:
        def fail(data_json):
            manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
            found = next(r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"])
            # A concurrent successful retry is final; a failed retry must not downgrade it.
            if found.get("state") != "uploaded": found["state"] = "failed"
            next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
            return next_data, None
        await repo.mutate_meeting_data(meeting_id, fail)
        raise

    def acknowledge(data_json):
        manifest = _manifest(meeting_id, data_json.get("attributed_audio_manifest"))
        found = next(r for r in manifest["ranges"] if r.get("idempotency_key") == incoming["idempotency_key"])
        found["state"] = "uploaded"; found["storage_path"] = key
        next_data = dict(data_json); next_data["attributed_audio_manifest"] = manifest
        return next_data, dict(found)
    return await repo.mutate_meeting_data(meeting_id, acknowledge)


async def close_attributed_manifest(repo, *, token_meeting_id: Optional[int], session_uid: str, expected_sequences: Optional[list[int]] = None) -> dict:
    session = await repo.find_session(session_uid)
    if session is None: raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id: raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")
    expected = set(expected_sequences or [])
    if any(not isinstance(value, int) or value < 0 for value in expected): raise AttributedConflict("invalid admitted sequence ledger")
    def close(data_json):
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
    manifest = await repo.attributed_manifest_for_owner(user_id, meeting_id)
    if not manifest: raise SessionNotFound("attributed audio manifest not found")
    return public_manifest(manifest)


async def attributed_range_for_owner(repo, storage, *, user_id: int, meeting_id: int, sequence: int) -> bytes:
    manifest = await repo.attributed_manifest_for_owner(user_id, meeting_id)
    if not manifest or manifest.get("state") != "closed": raise SessionNotFound("attributed audio range not found")
    value = next((r for r in manifest.get("ranges", []) if r.get("sequence") == sequence and r.get("state") == "uploaded"), None)
    path = value.get("storage_path") if isinstance(value, dict) else None
    if not isinstance(path, str) or not path.startswith("attributed-audio/"): raise SessionNotFound("attributed audio range not found")
    return await storage.get(path)
