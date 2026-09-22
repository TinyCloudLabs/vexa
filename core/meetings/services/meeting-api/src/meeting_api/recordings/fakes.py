"""In-process fakes for the recordings ports — for this module's tests (drive the SAME shipped
``upload_chunk`` / ``finalize_master`` / ``build_router`` offline, no MinIO, no DB).

  * ``InMemoryStorage`` — a dict-backed ``Storage`` (key → bytes); ``list`` returns sorted keys
    under a prefix, so finalize gathers a recording's chunks deterministically.
  * ``InMemoryRecordingRepo`` — seeds meetings + sessions, holds ``meeting.data['recordings']`` in a
    dict, and serves the read/modify-write the upload flow uses.

NO production logic — they only stand in for object storage + Postgres so recordings run fully
in-process.
"""
from __future__ import annotations

from typing import Optional


class InMemoryStorage:
    """A dict-backed ``Storage`` (key → bytes)."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        # Object mtimes (epoch seconds). The budget janitor evicts oldest-first, so a fake that
        # cannot express age could not drive that decision at all. ``upload`` stamps a monotonically
        # increasing counter (upload order IS age order); ``touch`` sets one explicitly.
        self.mtimes: dict[str, float] = {}
        self._clock = 0.0
        self.deleted: list[str] = []

    async def upload(self, key: str, data: bytes, *, content_type: str) -> None:
        self.blobs[key] = data
        self.content_types[key] = content_type
        self._clock += 1.0
        self.mtimes[key] = self._clock

    def touch(self, key: str, when: float) -> None:
        """Set an object's mtime (epoch seconds) so a test can order tapes by age explicitly."""
        self.mtimes[key] = when

    async def list(self, prefix: str) -> list[str]:
        return sorted(k for k in self.blobs if k.startswith(prefix))

    async def list_detailed(self, prefix: str) -> list[dict]:
        return [
            {"key": k, "size": len(self.blobs[k]), "last_modified": self.mtimes.get(k, 0.0)}
            for k in sorted(self.blobs)
            if k.startswith(prefix)
        ]

    async def delete(self, key: str) -> None:
        self.blobs.pop(key, None)
        self.content_types.pop(key, None)
        self.mtimes.pop(key, None)
        self.deleted.append(key)

    async def get(self, key: str) -> bytes:
        return self.blobs[key]

    async def size(self, key: str) -> int:
        return len(self.blobs[key])

    async def get_range(self, key: str, start: int, end: int) -> bytes:
        # INCLUSIVE [start, end], like S3's get_object(Range=...).
        return self.blobs[key][start : end + 1]

    async def exists(self, key: str) -> bool:
        return key in self.blobs


class InMemoryRecordingRepo:
    """A dict-backed ``RecordingRepo``. ``seed`` plants a meeting + its bot session."""

    def __init__(self):
        # meeting_id -> {user_id, recordings: [...]}; session_uid -> meeting_id
        self._meetings: dict[int, dict] = {}
        self._sessions: dict[str, int] = {}

    def seed(
        self, *, meeting_id: int, user_id: int, session_uid: str, status: str = "active"
    ) -> None:
        self._meetings.setdefault(
            meeting_id, {"user_id": user_id, "status": status, "recordings": []}
        )
        self._sessions[session_uid] = meeting_id

    async def find_session(self, session_uid: str) -> Optional[dict]:
        mid = self._sessions.get(session_uid)
        return {"meeting_id": mid, "session_uid": session_uid} if mid is not None else None

    async def get_recordings(self, meeting_id: int) -> list[dict]:
        return list(self._meetings.get(meeting_id, {}).get("recordings", []))

    async def put_recordings(self, meeting_id: int, recordings: list[dict]) -> None:
        self._meetings.setdefault(meeting_id, {"user_id": None, "recordings": []})
        self._meetings[meeting_id]["recordings"] = list(recordings)

    async def mutate_recordings(self, meeting_id: int, mutator):
        # Read the LIVE list, apply, write back — synchronously (no await), so it is atomic within the
        # event loop (mirrors the SQL adapter's row-locked read→modify→write; G3).
        self._meetings.setdefault(meeting_id, {"user_id": None, "recordings": []})
        recordings = list(self._meetings[meeting_id].get("recordings", []))
        new_recordings, result = mutator(recordings)
        self._meetings[meeting_id]["recordings"] = list(new_recordings)
        return result

    async def mutate_meeting_data(self, meeting_id: int, mutator):
        self._meetings.setdefault(meeting_id, {"user_id": None, "recordings": []})
        meeting = self._meetings[meeting_id]
        data = dict(meeting.get("data") or {})
        next_data, result = mutator(data)
        meeting["data"] = dict(next_data)
        # Production stores recordings in this same JSONB document. Older focused fixtures keep a
        # convenient top-level mirror, so retain that mirror when a complete-data mutation changes
        # the durable recordings list.
        if "recordings" in next_data:
            meeting["recordings"] = list(next_data["recordings"])
        return result

    async def attributed_manifest_for_owner(self, user_id: int, meeting_id: int) -> Optional[dict]:
        meeting = self._meetings.get(meeting_id)
        if not meeting or meeting.get("user_id") != user_id:
            return None
        value = (meeting.get("data") or {}).get("attributed_audio_manifest")
        return dict(value) if isinstance(value, dict) else None

    async def owner_of(self, meeting_id: int) -> Optional[int]:
        return self._meetings.get(meeting_id, {}).get("user_id")

    async def prepare_recording_deletion(self, user_id: int, recording_id: int) -> Optional[dict]:
        for meeting_id, meeting in self._meetings.items():
            if meeting.get("user_id") != user_id:
                continue
            recording = next(
                (r for r in meeting.get("recordings", []) if r.get("id") == recording_id), None
            )
            if recording is None:
                continue
            if meeting.get("status") not in ("completed", "failed"):
                return {"error": "conflict"}
            prepared = {**recording, "deletion_pending": True, "meeting_id": meeting_id}
            meeting["recordings"] = [
                prepared if r.get("id") == recording_id else r
                for r in meeting.get("recordings", [])
            ]
            return prepared
        return None

    async def list_meeting_recordings(self, user_id: int) -> list[dict]:
        out: list[dict] = []
        for mid, m in self._meetings.items():
            if m.get("user_id") == user_id:
                for r in m.get("recordings", []):
                    out.append({**r, "meeting_id": mid})
        return out
