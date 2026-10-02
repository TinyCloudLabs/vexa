"""TC-583 — storage-shape equivalence: table-backed ledger vs inline manifest.

The attributed-audio.v1 contract is what the routes return — not how the ranges are stored.
This test drives an identical scripted operation sequence through TWO repo implementations of
the new async-mutator contract and asserts every response is byte-identical:

  * ``InlineRangeRepo``   — the pre-TC-583 shape: the whole manifest (ranges included) lives
    inside ``meetings.data``. Storage is inline, but the mutator still sees a RangeLedger over
    the shared inline list (the fake's contract since TC-583).
  * ``TableRangeRepo``    — the post-TC-583 shape: only the manifest HEADER lives in
    ``meetings.data``; each range is a row in a per-meeting table (``self._table``), exactly
    like ``attributed_audio_ranges``. Its mutate runs the SAME lifecycle as
    ``SqlAlchemyRecordingRepo.mutate_meeting_data``: bind a ledger view, migrate inline legacy
    rows FIRST, run the mutator, then flush staged appends / dirty vended rows / wholesale
    reconcile / delete-on-removal — and stores the header only.

Script coverage: reserve, idempotent replay, conflicting idempotency-key metadata, duplicate
sequence, clock-origin conflict, upload/seal, fail, retain-after-uncertain-upload, close,
closed-manifest replay + rejection, artifact-deletion tombstone fencing, a second meeting whose
ranges are still INLINE in meetings.data (legacy row migration on first write), owner GET
manifest + range download, the internal session manifest, and owner-scoped recording delete.

Because every assertion compares (status, body) between the two stacks, a divergence in the
write-back, assembly, ordering, or error path fails here without needing Postgres.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn import mint_meeting_token
from meeting_api.recordings import build_router, upload_chunk
from meeting_api.recordings.deletion import delete_owned_recording
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage
from meeting_api.recordings.ledger import (
    RangeLedger,
    ledger_manifest,
    run_meeting_data_mutator,
    stored_manifest,
    union_ranges,
)

SECRET = "test-admin-token"
USER = 7
MEETING_ID = 1
SESSION_UID = "conn-abc"


# -----------------------------------------------------------------------------------------------
# The table-backed repo fixture (the post-TC-583 shape, emulated)
# -----------------------------------------------------------------------------------------------


class _TableRangeLedger(RangeLedger):
    """A ``RangeLedger`` over a dict keyed by ``(meeting_id, seq)`` — the in-memory mirror of the
    ``attributed_audio_ranges`` table. Same contract as ``SqlRangeLedger``: keyed probes consult
    staged appends first, then the table; vended rows are tracked so ``flush`` writes back only
    dirty payloads; ``append`` stages a row; ``migrate`` folds legacy inline rows in first."""

    def __init__(self, table: dict):
        # table: {meeting_id: [(row_id, payload_dict) ...]} — row order == id order == append order
        self._table = table
        self._rows: Optional[list] = None
        self._appends: list[dict] = []
        self._vended: dict[int, dict] = {}     # id(payload dict) -> live dict
        self._snapshots: dict[int, dict] = {}  # id(payload dict) -> payload at vend time
        self._sources: dict[int, dict] = {}    # id(payload dict) -> the table's payload dict

    def _vend(self, payload) -> dict:
        row = dict(payload or {})
        self._vended[id(row)] = row
        self._snapshots[id(row)] = dict(row)
        self._sources[id(row)] = payload
        return row

    async def all(self) -> list:
        if self._rows is None:
            self._rows = [self._vend(payload) for _id, payload in self._table]
            self._rows.extend(self._appends)
        return self._rows

    async def find(self, idempotency_key) -> Optional[dict]:
        for row in reversed(self._appends):
            if row.get("idempotency_key") == idempotency_key:
                return row
        if self._rows is not None:
            return next((r for r in self._rows if r.get("idempotency_key") == idempotency_key), None)
        for _id, payload in self._table:
            if (payload or {}).get("idempotency_key") == idempotency_key:
                return self._vend(payload)
        return None

    async def has_sequence(self, sequence: int) -> bool:
        if any(r.get("sequence") == sequence for r in self._appends):
            return True
        if self._rows is not None:
            return any(r.get("sequence") == sequence for r in self._rows)
        return any((p or {}).get("sequence") == sequence for _id, p in self._table)

    async def empty(self) -> bool:
        if self._appends:
            return False
        if self._rows is not None:
            return not self._rows
        return not self._table

    def append(self, row: dict) -> None:
        self._appends.append(row)
        if self._rows is not None:
            self._rows.append(row)
    async def migrate(self, legacy_rows) -> None:
        """Fold pre-table inline rows into the table in ``union_ranges`` order — the same
        merge the SQL ledger writes back (inline positions kept, non-colliding table rows
        appended, collisions carry the more-advanced payload, malformed/dup inline rows
        dropped)."""
        merged = union_ranges(
            [dict(r) for r in legacy_rows if isinstance(r, dict)],
            [dict(p) for _id, p in self._table],
            meeting_id=None,
        )
        # Rewrite the table in union order (mirrors SqlRangeLedger.migrate's delete+reinsert).
        self._table.clear()
        for i, row in enumerate(merged):
            self._table.append((i + 1, row))

    async def flush(self) -> None:
        """Persist staged appends and dirty vended rows; clean vended rows cost no write."""
        for row in self._appends:
            next_id = (max((_id for _id, _p in self._table), default=0) + 1)
            self._table.append((next_id, dict(row)))
        for row in self._vended.values():
            source = self._sources.get(id(row))
            if source is None or row == self._snapshots.get(id(row)):
                continue
            source.clear()
            source.update(dict(row))
        self._appends.clear()
        self._vended.clear()
        self._snapshots.clear()
        self._sources.clear()


class _TableRangeRepo(InMemoryRecordingRepo):
    """The post-TC-583 durable shape, emulated: header-only manifest in ``data['attributed_audio_
    manifest']`` plus a per-meeting range table. ``mutate_meeting_data`` mirrors
    ``SqlAlchemyRecordingRepo.mutate_meeting_data`` step for step."""

    def __init__(self):
        super().__init__()
        self._tables: dict[int, list] = {}  # meeting_id -> [(row_id, payload)]

    def _table(self, meeting_id: int) -> list:
        return self._tables.setdefault(meeting_id, [])

    async def mutate_meeting_data(self, meeting_id: int, mutator):
        self._meetings.setdefault(meeting_id, {"user_id": None, "recordings": []})
        meeting = self._meetings[meeting_id]
        table = self._table(meeting_id)
        data = dict(meeting.get("data") or {})
        stored = data.get("attributed_audio_manifest")
        ledger = None
        if isinstance(stored, dict):
            ledger = _TableRangeLedger(table)
            # Migrate legacy inline rows BEFORE the mutator, mirroring the SQL adapter.
            await ledger.migrate(
                [dict(r) for r in stored.get("ranges") or [] if isinstance(r, dict)]
            )
            data["attributed_audio_manifest"] = ledger_manifest(stored, ledger)
        next_data, result = await mutator(data)
        next_data = dict(next_data)
        new_manifest = next_data.get("attributed_audio_manifest")
        if not isinstance(new_manifest, dict):
            next_data.pop("attributed_audio_manifest", None)
            table.clear()  # manifest key removed → drop every range row (artifact deletion)
        elif ledger is not None and new_manifest.get("ranges") is ledger:
            next_data["attributed_audio_manifest"] = stored_manifest(new_manifest)
            await ledger.flush()
        else:
            # Mutator replaced the manifest wholesale → reconcile the table under the lock.
            table.clear()
            rows = new_manifest.get("ranges")
            for row in rows if isinstance(rows, list) else []:
                if isinstance(row, dict):
                    table.append((len(table) + 1, dict(row)))
            next_data["attributed_audio_manifest"] = stored_manifest(new_manifest)
        meeting["data"] = dict(next_data)
        if "recordings" in next_data:
            meeting["recordings"] = list(next_data["recordings"])
        return result

    async def attributed_artifacts_for_owner(self, user_id: int, meeting_id: int) -> Optional[dict]:
        meeting = self._meetings.get(meeting_id)
        if not meeting or meeting.get("user_id") != user_id:
            return None
        data = meeting.get("data") or {}
        header = data.get("attributed_audio_manifest")
        manifest = None
        if isinstance(header, dict):
            # Same assembly as ``union_ranges``: stored header + ordered table rows, unioning
            # any pre-table inline rows still in the header (inline positions kept).
            manifest = dict(header)
            manifest["ranges"] = union_ranges(
                header.get("ranges") or [],
                [payload for _id, payload in self._table(meeting_id)],
                meeting_id=meeting_id,
            )
        return {
            "manifest": manifest,
            "artifact_deletion": dict(data["artifact_deletion"])
            if isinstance(data.get("artifact_deletion"), dict) else None,
        }

    async def attributed_range_state_for_owner(self, user_id: int, meeting_id: int, sequence: int):
        """Mirrors the SQL keyed read: one (meeting_id, sequence) probe over the table rows,
        falling back to inline ``ranges`` when no table row exists (pre-migration meeting)."""
        meeting = self._meetings.get(meeting_id)
        if not meeting or meeting.get("user_id") != user_id:
            return None
        data = meeting.get("data") or {}
        found = next(
            (payload for _id, payload in self._table(meeting_id)
             if (payload or {}).get("sequence") == sequence),
            None,
        )
        if found is None:
            manifest = data.get("attributed_audio_manifest")
            ranges = manifest.get("ranges") if isinstance(manifest, dict) else []
            found = next(
                (r for r in ranges or []
                 if isinstance(r, dict) and r.get("sequence") == sequence),
                None,
            )
        return {"data": dict(data), "range": dict(found) if found else None}

class InlineRangeRepo(InMemoryRecordingRepo):
    """Alias for readability: the inline-JSONB durable shape via the shared runner."""


# -----------------------------------------------------------------------------------------------
# Script drivers
# -----------------------------------------------------------------------------------------------


def _meta(sequence: int, key: str, pcm: bytes, **overrides) -> dict:
    sample_rate, channels = 16000, 1
    meta = {
        "version": 1, "meeting_id": str(MEETING_ID), "sequence": sequence,
        "idempotency_key": key, "speaker_key": "channel:0", "speaker_name": "",
        "channel": 0, "turn_generation": 1,
        "attribution": {"source": "unresolved", "confidence": 0},
        "clock_origin_ms": 1000, "start_ms": sequence * 250,
        "audio_duration_ms": len(pcm) / (sample_rate * channels * 4) * 1000,
        "codec": "pcm_f32le", "sample_rate": sample_rate,
        "channels": channels, "byte_count": len(pcm), "sha256": hashlib.sha256(pcm).hexdigest(),
    }
    meta["end_ms"] = meta["start_ms"] + meta["audio_duration_ms"]
    meta.update(overrides)
    return meta


def _wav(n_data: int = 4) -> bytes:
    import struct

    data = b"\x00" * n_data
    fmt = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 1, 16000, 32000, 2, 16)
    chunk = struct.pack("<4sI", b"data", len(data)) + data
    riff_len = 4 + len(fmt) + len(chunk)
    return struct.pack("<4sI4s", b"RIFF", riff_len, b"WAVE") + fmt + chunk


def _client(repo, storage):
    app = FastAPI()
    app.include_router(build_router(repo, storage, token_secret=SECRET))
    return TestClient(app)


def _seed(repo, *, status="active"):
    repo.seed(meeting_id=MEETING_ID, user_id=USER, session_uid=SESSION_UID, status=status)


def _post_reserve(client, meta, token):
    return client.post("/internal/attributed-audio/reserve",
                       headers={"authorization": f"Bearer {token}"},
                       data={"session_uid": SESSION_UID, "range_metadata": json.dumps(meta)})


def _post_upload(client, meta, pcm, token):
    return client.post("/internal/attributed-audio/upload",
                       headers={"authorization": f"Bearer {token}"},
                       data={"session_uid": SESSION_UID, "range_metadata": json.dumps(meta)},
                       files={"file": ("range.pcm", pcm, "application/octet-stream")})


def _post_fail(client, meta, token):
    return client.post("/internal/attributed-audio/fail",
                       headers={"authorization": f"Bearer {token}"},
                       data={"session_uid": SESSION_UID, "range_metadata": json.dumps(meta)})


def _post_close(client, expected, token):
    return client.post("/internal/attributed-audio/close",
                       headers={"authorization": f"Bearer {token}"},
                       data={"session_uid": SESSION_UID,
                             "admitted_sequences": json.dumps(expected)})


def _get_public_manifest(client):
    return client.get(f"/meetings/{MEETING_ID}/attributed-audio",
                      headers={"x-user-id": str(USER)})


def _get_internal_manifest(client, token):
    return client.get("/internal/attributed-audio/manifest",
                      params={"session_uid": SESSION_UID},
                      headers={"authorization": f"Bearer {token}"})


def _get_range(client, sequence):
    return client.get(f"/meetings/{MEETING_ID}/attributed-audio/ranges/{sequence}",
                      headers={"x-user-id": str(USER)})


def _norm(response):
    """(status, body) — JSON bodies compared as parsed objects; PCM bodies compared as bytes."""
    ctype = response.headers.get("content-type", "")
    if "json" in ctype:
        return response.status_code, json.loads(response.content)
    return response.status_code, response.content


def _run_script(make_repo, *, seed_artifact_deletion=None, close_expected=True):
    """Drive the identical attributed-audio script through one stack; returns a transcript of
    (label, status, body) tuples plus terminal state probes for cross-stack comparison."""
    repo, storage = make_repo(), InMemoryStorage()
    _seed(repo)
    if seed_artifact_deletion is not None:
        repo._meetings[MEETING_ID].setdefault("data", {}).setdefault(
            "artifact_deletion", seed_artifact_deletion
        )
    client = _client(repo, storage)
    token = mint_meeting_token(MEETING_ID, USER, "google_meet", "abc-defg-hij", secret=SECRET)
    trace = []

    def record(label, response):
        trace.append((label, *_norm(response)))

    pcm0 = b"\x00\x00\x80?" * 4
    pcm1 = b"\x00\x00\x00@" * 4
    meta0 = _meta(0, "turn-0", pcm0)
    meta0_same = dict(meta0)
    meta0_conflict = dict(meta0, speaker_name="different")
    meta_seq_clash = _meta(0, "other-key", pcm1)
    meta_bad_origin = _meta(9, "bad-origin", pcm1, clock_origin_ms=9999)
    meta1 = _meta(1, "turn-1", pcm1)
    meta_fail = _meta(2, "turn-2", pcm1)

    # reserve → replay → metadata conflict → sequence conflict → clock-origin conflict
    record("reserve-0", _post_reserve(client, meta0, token))
    record("reserve-0-replay", _post_reserve(client, meta0_same, token))
    record("reserve-0-metadata-conflict", _post_reserve(client, meta0_conflict, token))
    record("reserve-seq-clash", _post_reserve(client, meta_seq_clash, token))
    record("reserve-bad-origin", _post_reserve(client, meta_bad_origin, token))

    # upload → idempotent re-upload → fail a second range → reserve+upload a third
    record("upload-0", _post_upload(client, meta0, pcm0, token))
    record("upload-0-replay", _post_upload(client, meta0, pcm0, token))
    record("reserve-1", _post_reserve(client, meta1, token))
    record("fail-1", _post_fail(client, meta1, token))
    record("reserve-2", _post_reserve(client, meta_fail, token))
    record("upload-2", _post_upload(client, meta_fail, pcm1, token))

    # read both manifests + the owner range download mid-flight
    record("get-public-open", _get_public_manifest(client))
    record("get-internal-open", _get_internal_manifest(client, token))
    record("get-range-0", _get_range(client, 0))

    # close → replay close → post-close reserve rejected → post-close manifest reads
    record("close", _post_close(client, [0, 1, 2], token))
    record("close-replay", _post_close(client, [0, 1, 2], token))
    record("reserve-post-close", _post_reserve(client, _meta(3, "turn-3", pcm0), token))
    record("get-public-closed", _get_public_manifest(client))
    record("get-range-0-closed", _get_range(client, 0))
    record("get-range-1-closed", _get_range(client, 1))

    return repo, storage, trace


def _storage_blobs(storage):
    return sorted(storage.blobs.items())


# -----------------------------------------------------------------------------------------------
# The equivalence assertions
# -----------------------------------------------------------------------------------------------


def test_table_ledger_matches_inline_manifest_for_the_full_operation_script():
    """Every route response and the terminal durable state are identical whether ranges live in
    the per-range table shape or the pre-TC-583 inline manifest."""
    inline_repo, inline_storage, inline_trace = _run_script(InlineRangeRepo)
    table_repo, table_storage, table_trace = _run_script(_TableRangeRepo)

    assert inline_trace == table_trace
    assert _storage_blobs(inline_storage) == _storage_blobs(table_storage)

    # Terminal state assertions on the table side specifically prove the write-back lands:
    # header-only manifest in meetings.data, ordered rows in the table.
    data = table_repo._meetings[MEETING_ID]["data"]
    manifest = data["attributed_audio_manifest"]
    assert manifest["state"] == "closed"
    assert "ranges" not in manifest  # header only — the whole point of TC-583
    rows = table_repo._table(MEETING_ID)
    assert [p["idempotency_key"] for _id, p in rows] == ["turn-0", "turn-1", "turn-2"]
    # Order matters to the contract: the assembled public manifest must present the durable
    # append order, which the trace comparison already asserted byte-for-byte.
    assert len(rows) == 3


def test_table_ledger_matches_inline_manifest_on_tombstoned_meeting():
    """An artifact_deletion tombstone fences writes identically on both shapes."""
    tombstone = {"state": "pending", "cleanup_version": 1, "requested_at": "x"}

    inline_repo, inline_storage, inline_trace = _run_script(
        InlineRangeRepo, seed_artifact_deletion=tombstone)
    table_repo, table_storage, table_trace = _run_script(
        _TableRangeRepo, seed_artifact_deletion=tombstone)

    assert inline_trace == table_trace
    # Both fenced every write (409s); nothing landed in storage on either side.
    assert _storage_blobs(inline_storage) == _storage_blobs(table_storage)


def test_legacy_inline_ranges_migrate_into_the_table_and_stay_readable():
    """A pre-TC-583 meeting has ranges INLINE in meetings.data and an empty table. The first
    row-locked write migrates them; readers keep seeing the unioned manifest in the same order,
    and the inline list leaves meetings.data."""
    inline_repo = InlineRangeRepo()
    table_repo = _TableRangeRepo()
    for repo in (inline_repo, table_repo):
        _seed(repo)
        repo._meetings[MEETING_ID]["data"] = {
            "attributed_audio_manifest": {
                "version": 1, "meeting_id": str(MEETING_ID),
                "clock_origin": "first_admitted_capture_epoch_ms",
                "clock_origin_ms": 500, "state": "open",
                "ranges": [
                    dict(_meta(0, "legacy-0", b"aaa"), state="uploaded",
                         path="/meetings/1/attributed-audio/ranges/0",
                         storage_path="attributed-audio/7/1/conn-abc/000000-aaa.pcm"),
                    dict(_meta(1, "legacy-1", b"bbb"), state="failed",
                         path="/meetings/1/attributed-audio/ranges/1",
                         storage_path="attributed-audio/7/1/conn-abc/000001-bbb.pcm"),
                ],
            }
        }

    traces = {}
    for name, repo in (("inline", inline_repo), ("table", table_repo)):
        storage = InMemoryStorage()
        # The legacy objects exist in storage so owner downloads work.
        storage.blobs["attributed-audio/7/1/conn-abc/000000-aaa.pcm"] = b"aaa"
        storage.blobs["attributed-audio/7/1/conn-abc/000001-bbb.pcm"] = b"bbb"
        client = _client(repo, storage)
        token = mint_meeting_token(MEETING_ID, USER, "google_meet", "abc-defg-hij", secret=SECRET)
        pcm = b"\x00\x00\x80?" * 4
        meta_new = _meta(2, "turn-2", pcm, clock_origin_ms=500)
        trace = [
            ("get-public-pre", *_norm(_get_public_manifest(client))),
            ("get-internal-pre", *_norm(_get_internal_manifest(client, token))),
            # A reserve whose idempotency key exists only in the INLINE rows must be a replay,
            # not a duplicate — the migration runs before the mutator's probes.
            ("reserve-legacy-replay", *_norm(_post_reserve(
                client, dict(_meta(0, "legacy-0", b"aaa"), clock_origin_ms=500), token))),
            # A sequence that exists only inline must conflict.
            ("reserve-legacy-seq", *_norm(_post_reserve(
                client, dict(_meta(1, "new-key", b"ccc"), clock_origin_ms=500), token))),
            ("reserve-new", *_norm(_post_reserve(client, meta_new, token))),
            ("upload-new", *_norm(_post_upload(client, meta_new, pcm, token))),
            ("get-public-post", *_norm(_get_public_manifest(client))),
            ("get-range-legacy", *_norm(_get_range(client, 0))),
        ]
        traces[name] = trace

    assert traces["inline"] == traces["table"]

    # Table-side durable assertions: the two legacy rows migrated out of meetings.data into the
    # table, and the table preserves append order (legacy first, new range last).
    header = table_repo._meetings[MEETING_ID]["data"]["attributed_audio_manifest"]
    assert "ranges" not in header
    payloads = [p for _id, p in table_repo._table(MEETING_ID)]
    assert [p["idempotency_key"] for p in payloads] == ["legacy-0", "legacy-1", "turn-2"]


def test_owner_scoped_recording_delete_removes_artifact_identically():
    """DELETE /recordings/{id} tombstones + drops ranges + deletes objects on both shapes."""
    outcomes = {}
    for name, make_repo in (("inline", InlineRangeRepo), ("table", _TableRangeRepo)):
        repo, storage = make_repo(), InMemoryStorage()
        _seed(repo, status="completed")
        client = _client(repo, storage)
        token = mint_meeting_token(MEETING_ID, USER, "google_meet", "abc-defg-hij", secret=SECRET)
        pcm = b"\x00\x00\x80?" * 4
        meta = _meta(0, "turn-0", pcm)
        reserve = _post_reserve(client, meta, token)
        upload = _post_upload(client, meta, pcm, token)
        receipt = asyncio.run(upload_chunk(
            repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            data=_wav(), media_format="wav", chunk_seq=0, is_final=True,
        ))
        deleted = client.delete(f"/recordings/{receipt['recording_id']}",
                                headers={"x-user-id": str(USER)})
        # A stale token must not recreate the artifact after the durable tombstone.
        post = _post_reserve(client, meta, token)
        outcomes[name] = {
            "reserve": _norm(reserve), "upload": _norm(upload),
            "deleted": _norm(deleted), "post_delete_reserve": _norm(post),
            "manifest_key": "attributed_audio_manifest" in repo._meetings[MEETING_ID]["data"],
            "deletion_state": repo._meetings[MEETING_ID]["data"]["artifact_deletion"]["state"],
            "blobs": _storage_blobs(storage),
            "recordings": repo._meetings[MEETING_ID].get("recordings"),
        }

    assert outcomes["inline"]["reserve"] == outcomes["table"]["reserve"]
    assert outcomes["inline"]["upload"] == outcomes["table"]["upload"]
    assert outcomes["inline"]["deleted"][0] == outcomes["table"]["deleted"][0]
    assert outcomes["inline"]["deleted"][1]["objects_deleted"] == \
        outcomes["table"]["deleted"][1]["objects_deleted"]
    assert outcomes["inline"]["post_delete_reserve"] == outcomes["table"]["post_delete_reserve"]
    assert outcomes["table"]["manifest_key"] is False
    assert outcomes["table"]["deletion_state"] == "completed"
    assert outcomes["table"]["blobs"] == []


def test_uncertain_upload_retains_cleanup_obligation_on_both_shapes():
    """A PUT whose ack PUT-then-delete race is uncertain retains a fenced cleanup row on both
    shapes — the reservation keeps its deterministic key for deletion/reconciliation."""
    for make_repo in (InlineRangeRepo, _TableRangeRepo):
        repo, storage = make_repo(), InMemoryStorage()
        _seed(repo)
        client = _client(repo, storage)
        token = mint_meeting_token(MEETING_ID, USER, "google_meet", "abc-defg-hij", secret=SECRET)
        pcm = b"\x00\x00\x80?" * 4
        meta = _meta(0, "turn-0", pcm)
        assert _post_reserve(client, meta, token).status_code == 200

        class _FlakyStorage(InMemoryStorage):
            async def upload(self, key, data, *, content_type):
                self.blobs[key] = data      # the write MAY have landed
                raise RuntimeError("ack lost")

        flaky = _FlakyStorage()
        flaky_client = _client(repo, flaky)
        resp = flaky_client.post("/internal/attributed-audio/upload",
                                 headers={"authorization": f"Bearer {token}"},
                                 data={"session_uid": SESSION_UID,
                                       "range_metadata": json.dumps(meta)},
                                 files={"file": ("range.pcm", pcm, "application/octet-stream")})
        # Route maps storage failure to 502 on both stacks; the reservation stays failed-durable.
        assert resp.status_code == 502
        manifest = asyncio.run(
            __import__("meeting_api.recordings.attributed", fromlist=["x"])
            .attributed_manifest_for_session(repo, token_meeting_id=MEETING_ID,
                                             session_uid=SESSION_UID)
        )
        assert [r["idempotency_key"] for r in manifest["ranges"]] == ["turn-0"]
        assert manifest["ranges"][0]["state"] == "failed"


def test_overlap_preserves_union_order_and_more_advanced_state():
    """Inline [2, 8] where the table already holds seq-8: reads see [2, 8] (inline positions
    kept); the first write migrates THAT order — never [8, 2] — and the inline sealed twin does
    not regress the table row's uploaded payload."""
    pcm = b"\x00\x00\x80?" * 4
    outcomes = {}
    table_repo = None
    for name, make_repo in (("inline", InlineRangeRepo), ("table", _TableRangeRepo)):
        repo, storage = make_repo(), InMemoryStorage()
        if name == "table":
            table_repo = repo
        _seed(repo)
        data = repo._meetings[MEETING_ID].setdefault("data", {})
        data["attributed_audio_manifest"] = {
            "version": 1, "meeting_id": str(MEETING_ID),
            "clock_origin": "first_admitted_capture_epoch_ms",
            "clock_origin_ms": 500, "state": "open",
            "ranges": [
                dict(_meta(2, "in-2", pcm, clock_origin_ms=500), state="uploaded",
                     storage_path="attributed-audio/7/1/s/2.pcm"),
                dict(_meta(8, "tbl-8", pcm, clock_origin_ms=500), state="sealed",
                     storage_path="attributed-audio/7/1/s/8.pcm"),
            ],
        }
        if name == "table":
            # A range the table shape wrote before this meeting's first write under the new code.
            repo._table(MEETING_ID).append((1, dict(
                _meta(8, "tbl-8", pcm, clock_origin_ms=500), state="uploaded",
                storage_path="attributed-audio/7/1/s/8.pcm")))
        storage.blobs["attributed-audio/7/1/s/2.pcm"] = pcm
        storage.blobs["attributed-audio/7/1/s/8.pcm"] = pcm
        client = _client(repo, storage)
        token = mint_meeting_token(MEETING_ID, USER, "google_meet", "abc-defg-hij", secret=SECRET)
        meta9 = _meta(9, "turn-9", pcm, clock_origin_ms=500)
        trace = [
            ("pre", *_norm(_get_public_manifest(client))),
            ("reserve-9", *_norm(_post_reserve(client, meta9, token))),
            ("post", *_norm(_get_public_manifest(client))),
        ]
        outcomes[name] = trace

    # The stacks legitimately differ on the collision: the table stack merges the uploaded table
    # payload over the sealed inline twin (the no-regression rule); the inline stack has no such
    # twin and serves the sealed row. What must NOT differ is ORDER — [2, 8] before the write,
    # [2, 8, 9] after — on both.
    assert [r["sequence"] for r in outcomes["inline"][0][2]["ranges"]] == [2, 8]
    assert [r["sequence"] for r in outcomes["table"][0][2]["ranges"]] == [2, 8]
    assert [r["sequence"] for r in outcomes["inline"][2][2]["ranges"]] == [2, 8, 9]
    assert [r["sequence"] for r in outcomes["table"][2][2]["ranges"]] == [2, 8, 9]
    # Table side: merged seq-8 kept uploaded; inline side: sealed (no table row existed there).
    assert outcomes["table"][0][2]["ranges"][1]["state"] == "uploaded"
    assert outcomes["inline"][0][2]["ranges"][1]["state"] == "sealed"
    # Table-side durable order = union order — inline positions kept, table row merged in place,
    # new range appended.
    rows = table_repo._table(MEETING_ID)
    assert [(p["sequence"], p["state"]) for _id, p in rows] == [
        (2, "uploaded"), (8, "uploaded"), (9, "sealed")]
    # The inline list left meetings.data on the migrating write.
    assert "ranges" not in table_repo._meetings[MEETING_ID]["data"]["attributed_audio_manifest"]


def test_union_ranges_crossed_collision_is_unique_in_both_axes():
    """Astra P3: inline (a,1,sealed),(b,2,sealed) + table (a,2,uploaded) — key collides at
    position 0 while sequence collides at position 1. The union must carry exactly one row per
    (key, sequence): the table's uploaded payload at the earliest slot, the crossed inline row
    dropped."""
    pcm = b"\x00\x00\x80?" * 4
    dropped = []
    merged = union_ranges(
        [dict(_meta(1, "a", pcm), state="sealed"),
         dict(_meta(2, "b", pcm), state="sealed")],
        [dict(_meta(2, "a", pcm), state="uploaded")],
        dropped_out=dropped,
    )
    assert [(r["sequence"], r["idempotency_key"], r["state"]) for r in merged] == [
        (2, "a", "uploaded")]
    # Both displaced inline rows are reported — the merged-out twin AND the crossed sibling.
    assert [r["idempotency_key"] for r in dropped] == ["a", "b"]


def test_union_ranges_rank_uploaded_above_failed():
    """Opus L4: a failed retry must never replace the uploaded row's storage_path."""
    uploaded = {"idempotency_key": "k", "sequence": 1, "state": "uploaded",
                "storage_path": "attributed-audio/7/1/s/1.pcm"}
    failed = {"idempotency_key": "k", "sequence": 1, "state": "failed"}
    assert union_ranges([], [uploaded, failed]) == [uploaded]
    assert union_ranges([], [failed, uploaded]) == [uploaded]
    # And an inline failed twin never displaces the table's uploaded row either.
    assert union_ranges([failed], [uploaded]) == [uploaded]


def test_crossed_collision_migrates_through_table_repo():
    """The crossed case end-to-end on the emulated table stack: the union read is unique on both
    axes, the first write migrates without a UniqueViolation, and the durable order equals the
    union order the read served."""
    pcm = b"\x00\x00\x80?" * 4
    repo, storage = _TableRangeRepo(), InMemoryStorage()
    _seed(repo)
    data = repo._meetings[MEETING_ID].setdefault("data", {})
    data["attributed_audio_manifest"] = {
        "version": 1, "meeting_id": str(MEETING_ID),
        "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open",
        "ranges": [dict(_meta(1, "a", pcm, clock_origin_ms=500), state="sealed"),
                   dict(_meta(2, "b", pcm, clock_origin_ms=500), state="sealed")],
    }
    repo._table(MEETING_ID).append((1, dict(
        _meta(2, "a", pcm, clock_origin_ms=500), state="uploaded",
        storage_path="attributed-audio/7/1/s/2.pcm")))
    storage.blobs["attributed-audio/7/1/s/2.pcm"] = pcm

    client = _client(repo, storage)
    pre = _get_public_manifest(client).json()
    assert [(r["sequence"], r["idempotency_key"]) for r in pre["ranges"]] == [(2, "a")]

    token = mint_meeting_token(MEETING_ID, USER, "google_meet", "abc-defg-hij", secret=SECRET)
    resp = _post_reserve(client, _meta(9, "post", pcm, clock_origin_ms=500), token)
    assert resp.status_code == 200  # migration wrote the union — no IntegrityError
    post = _get_public_manifest(client).json()
    assert [(r["sequence"], r["idempotency_key"]) for r in post["ranges"]] == [
        (2, "a"), (9, "post")]
    assert [(p["sequence"], p["idempotency_key"]) for _id, p in repo._table(MEETING_ID)] == [
        (2, "a"), (9, "post")]
    assert "ranges" not in repo._meetings[MEETING_ID]["data"]["attributed_audio_manifest"]


def test_union_ranges_stale_slot_regression():
    """Astra R5: inline (a,1,sealed) + table (a,2,uploaded),(b,1,uploaded) — the (a,2) merge
    displaces slot 0's sequence-1 registration; (b,1) must still land. And Opus R5: inline
    (a,2),(d,1),(b,0) + table (b,1),(a,0),(d,2) — no stale-slot merge, no crash, all table
    rows survive."""
    astra = union_ranges(
        [{"idempotency_key": "a", "sequence": 1, "state": "sealed"}],
        [{"idempotency_key": "a", "sequence": 2, "state": "uploaded"},
         {"idempotency_key": "b", "sequence": 1, "state": "uploaded"}],
    )
    assert [(r["idempotency_key"], r["sequence"]) for r in astra] == [("a", 2), ("b", 1)]

    dropped = []
    opus = union_ranges(
        [{"idempotency_key": "a", "sequence": 2, "state": "sealed"},
         {"idempotency_key": "d", "sequence": 1, "state": "sealed"},
         {"idempotency_key": "b", "sequence": 0, "state": "sealed"}],
        [{"idempotency_key": "b", "sequence": 1, "state": "sealed"},
         {"idempotency_key": "a", "sequence": 0, "state": "sealed"},
         {"idempotency_key": "d", "sequence": 2, "state": "sealed"}],
        dropped_out=dropped,
    )
    assert [(r["idempotency_key"], r["sequence"]) for r in opus] == [
        ("a", 0), ("b", 1), ("d", 2)]
    # All three table payloads survived; the three displaced inline rows are reported.
    assert sorted(r["idempotency_key"] for r in dropped) == ["a", "b", "d"]


def test_union_ranges_randomized_invariants():
    """Opus R5 property: for thousands of seeded random cases — each input unique on both axes,
    random states — the union never raises, is unique on key and on sequence, is deterministic,
    reports every non-surviving row, and never drops a table row except superseded by a
    strictly more-advanced row sharing an identity axis."""
    import random
    rng = random.Random(0x7C583)
    states = ["sealed", "uploaded", "failed"]

    def gen(prefix):
        keys = [f"{prefix}-k{i}" for i in range(rng.randint(2, 8))]
        seqs = list(range(rng.randint(2, 8)))
        n = min(len(keys), len(seqs), rng.randint(0, 6))
        rng.shuffle(keys)
        rng.shuffle(seqs)
        return [{"idempotency_key": keys[i], "sequence": seqs[i],
                 "state": rng.choice(states), "rowid": f"{prefix}{i}"}
                for i in range(n)]

    def rank(row):
        return {"sealed": 0, "failed": 2, "uploaded": 3}.get(row["state"], 0)

    for trial in range(4000):
        inline, table = gen("in"), gen("tb")
        dropped1, dropped2 = [], []
        first = union_ranges(inline, table, dropped_out=dropped1)
        # Determinism: same inputs, fresh copies, same output.
        second = union_ranges([dict(r) for r in inline], [dict(r) for r in table],
                              dropped_out=dropped2)
        assert first == second
        keys = [r["idempotency_key"] for r in first]
        seqs = [r["sequence"] for r in first]
        assert len(keys) == len(set(keys))
        assert len(seqs) == len(set(seqs))
        survived = {r["rowid"] for r in first}
        reported = {r["rowid"] for r in dropped1}
        every = {r["rowid"] for r in inline} | {r["rowid"] for r in table}
        assert survived.isdisjoint(reported)
        assert survived | reported == every  # every row accounted for exactly once
        # A table row absent from the union must chain strictly-upward in rank to a survivor
        # through shared-identity supersessions (transitively superseded rows count too).
        rank_of = {id(r): rank(r) for r in inline + table}
        edges = {}
        for r in inline + table:
            cand = [q for q in inline + table
                    if q is not r and rank(q) > rank(r)
                    and (q["idempotency_key"] == r["idempotency_key"]
                         or q["sequence"] == r["sequence"])]
            if cand:
                edges[r["rowid"]] = max(cand, key=lambda q: rank_of[id(q)])["rowid"]
        for r in table:
            if r["rowid"] in survived:
                continue
            seen, cur = set(), r["rowid"]
            while cur not in survived and cur in edges and cur not in seen:
                seen.add(cur)
                cur = edges[cur]
            assert cur in survived, (
                f"table row {r['rowid']} vanished without a strictly-more-advanced "
                f"same-identity successor (trial {trial})")
