"""Recording-owned speaker metadata. Shares audio authorization and the recording object namespace."""
from __future__ import annotations

import json
import math
from typing import Any

from .ports import Storage

MAX_CHUNK_BYTES = 65536
MAX_INTERVALS = 256
MAX_READ_BYTES = 8 * 1024 * 1024
MAX_READ_INTERVALS = 50000


def validate_timeline(value: Any) -> dict:
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("unsupported speaker timeline version")
    encoded = json.dumps(value, ensure_ascii=False).encode()
    if len(encoded) > MAX_CHUNK_BYTES:
        raise ValueError("speaker timeline exceeds chunk budget")
    origin = value.get("recording_started_at_ms")
    if type(origin) not in (int, float) or not math.isfinite(origin) or not 1e12 <= origin < 1e15:
        raise ValueError("invalid recording clock origin")
    items = value.get("intervals")
    if not isinstance(items, list) or len(items) > MAX_INTERVALS or type(value.get("capped")) is not bool:
        raise ValueError("invalid speaker intervals")
    intervals = []
    previous_end = 0
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("invalid speaker interval")
        start, end = item.get("start_ms"), item.get("end_ms")
        if (type(start) not in (int, float) or type(end) not in (int, float)
                or not math.isfinite(start) or not math.isfinite(end)
                or start < previous_end or end <= start or end >= 1e12):
            raise ValueError("invalid speaker interval clock")
        status = item.get("attribution")
        if status not in ("identified", "unknown", "overlap"):
            raise ValueError("invalid speaker attribution")
        participant, name = item.get("participant_id"), item.get("name")
        if status == "identified":
            if any(not isinstance(s, str) or not s.strip() or len(s) > 256 for s in (participant, name)):
                raise ValueError("identified speaker requires identity and name")
        else:
            participant = name = None
        intervals.append({"start_ms": start, "end_ms": end, "participant_id": participant,
                          "name": name, "attribution": status})
        previous_end = end
    return {"version": 1, "recording_started_at_ms": origin, "intervals": intervals, "capped": value["capped"]}


def timeline_prefix(owner: int, recording_id: int, session_uid: str) -> str:
    # The recording deletion path lists the session prefix, including all media and metadata.
    if not isinstance(session_uid, str) or not session_uid or "/" in session_uid or session_uid in (".", ".."):
        raise ValueError("invalid recording session")
    return f"recordings/{int(owner)}/{int(recording_id)}/{session_uid}/speaker-timeline/"


async def store_timeline(storage: Storage, *, owner: int, recording_id: int, chunk_seq: int, value: Any,
                         session_uid: str, audio_key: str, is_final: bool = False) -> None:
    if type(chunk_seq) is not int or not 0 <= chunk_seq < 1000000:
        raise ValueError("invalid timeline sequence")
    validated = validate_timeline(value)
    # Receiver-owned finality: never trust a browser field to certify upload completion.
    validated["chunk_seq"] = chunk_seq
    validated["is_final"] = is_final
    validated["audio_key"] = audio_key
    key = f"{timeline_prefix(owner, recording_id, session_uid)}{chunk_seq:06d}.json"
    encoded = json.dumps(validated, ensure_ascii=False).encode()
    if len(encoded) > MAX_CHUNK_BYTES:
        raise ValueError("speaker timeline envelope exceeds chunk budget")
    await storage.upload(key, encoded, content_type="application/json")


async def read_timeline(storage: Storage, *, owner: int, recording_id: int, session_uid: str) -> dict | None:
    prefix = timeline_prefix(owner, recording_id, session_uid)
    keys = sorted(k for k in await storage.list(prefix) if k.startswith(prefix) and k.endswith(".json"))
    if not keys:
        return None
    if len(keys) > 10000:
        raise ValueError("speaker timeline exceeds file budget")
    total_bytes = 0
    intervals: list[dict] = []
    origin = None
    capped = False
    final_seq = None
    audio_keys: list[str] = []
    audio_prefix = None
    for sequence, key in enumerate(keys):
        size = getattr(storage, "size", None)
        if size is not None and await size(key) > MAX_CHUNK_BYTES:
            raise ValueError("speaker timeline exceeds chunk budget")
        data = await storage.get(key)
        total_bytes += len(data)
        if len(data) > MAX_CHUNK_BYTES or total_bytes > MAX_READ_BYTES:
            raise ValueError("speaker timeline exceeds read budget")
        envelope = json.loads(data)
        if envelope.get("chunk_seq") != sequence or key != f"{prefix}{sequence:06d}.json":
            raise ValueError("speaker timeline has missing chunks")
        if type(envelope.get("is_final")) is not bool:
            raise ValueError("speaker timeline has no upload finality")
        if final_seq is not None:
            raise ValueError("speaker timeline has chunks after final upload")
        if envelope["is_final"]:
            final_seq = sequence
        audio_key = envelope.get("audio_key")
        if not isinstance(audio_key, str) or not audio_key.startswith(f"recordings/{int(owner)}/{int(recording_id)}/{session_uid}/audio/"):
            raise ValueError("speaker timeline audio ownership mismatch")
        part_prefix, filename = audio_key.rsplit("/", 1)
        if (not part_prefix.endswith("/audio") or not filename.startswith(f"{sequence:06d}.")
                or (audio_prefix is not None and audio_prefix != part_prefix)):
            raise ValueError("speaker timeline audio sequence mismatch")
        audio_prefix = part_prefix
        audio_keys.append(audio_key)
        part = validate_timeline(envelope)
        if origin is not None and origin != part["recording_started_at_ms"]:
            raise ValueError("speaker timeline recording clocks disagree")
        origin = part["recording_started_at_ms"]
        intervals.extend(part["intervals"])
        if len(intervals) > MAX_READ_INTERVALS:
            raise ValueError("speaker timeline exceeds interval budget")
        capped = capped or part["capped"]
    if final_seq is None:
        raise ValueError("speaker timeline upload incomplete")
    # The master byte-concatenates these exact chunks. A salvaged stream missing a chunk
    # cannot safely use recorder-relative speaker timing, even if its metadata survived.
    retained_audio = sorted(k for k in await storage.list(f"{audio_prefix}/")
                            if not k.rsplit("/", 1)[-1].startswith("master."))
    if retained_audio != audio_keys:
        raise ValueError("speaker timeline audio chunks incomplete or changed")
    return {"version": 1, "recording_id": recording_id, "recording_started_at_ms": origin,
            "intervals": intervals, "capped": capped}
