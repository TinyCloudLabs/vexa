"""TC-583 — real-Postgres conformance for the attributed range table.

The offline venv deliberately has no SQLAlchemy (adapters lazy-import it), so the fake suite can
never prove the ``SqlRangeLedger`` write path. These tests run only when
``MEETING_API_TEST_DATABASE_URL`` is set and sqlalchemy+asyncpg are importable — same convention
as ``test_single_flight.test_pg_advisory_lock_runs_on_real_postgres``.

Every test gets a DEDICATED SCRATCH DATABASE created/dropped inside the run
(``tc583_scratch_<pid>_<n>``) — the fixture never drops tables on the configured DSN, which
other suites also use. Proves, against real Postgres:

  * ``ensure_attributed_audio_schema`` is safe under N concurrent boots (advisory-locked —
    pg_type races produced DuplicateTableError/UniqueViolation crashes pre-fix) and is a no-op
    second call;
  * reserve → upload → fail → close through ``SqlAlchemyRecordingRepo.mutate_meeting_data``:
    ranges land as table rows, ``meetings.data`` keeps only the manifest header;
  * lazy migration preserves the externally visible union order (inline positions kept) and
    never lets a stale inline row regress a table row that reached uploaded/failed;
  * malformed duplicate inline rows are dropped (logged once at migration, not on reads), never
    an IntegrityError-per-write; crossed key/sequence collisions resolve to a union unique on
    both axes;
  * the owner manifest read is ONE statement (a mid-read committed delete cannot surface a
    closed-empty manifest that never existed);
  * keyed range downloads resolve by index, not whole-manifest assembly;
  * ``meeting_api.recordings.rollback`` folds table rows back inline in union order, leaves
    inline-only meetings untouched, deletes folded rows in the fold transaction, and drops the
    table — a rolled-back database is indistinguishable from a never-migrated one to the base
    image's read + completed-deletion paths;
  * per-operation write volume stays FLAT as ranges grow — the meeting-85 quadratic rewrite
    is gone.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

pytestmark = [
    pytest.mark.skipif(
        not os.getenv("MEETING_API_TEST_DATABASE_URL"),
        reason="real-Postgres conformance for the attributed ledger; "
               "set MEETING_API_TEST_DATABASE_URL to run",
    ),
]

MEETING_ID = 90001
USER = 7
SESSION_UID = "pg-conn-abc"
SECRET = "pg-test-token"

_scratch_counter = [0]


def _scratch_url(base_url: str) -> tuple[str, str]:
    """(admin DSN on the maintenance db, scratch DSN). The configured URL's database is never
    touched — scratch lives in a fresh ``tc583_scratch_*`` database."""
    _scratch_counter[0] += 1
    name = f"tc583_scratch_{os.getpid()}_{_scratch_counter[0]}"
    base = re.sub(r"/[^/]+$", "/postgres", base_url)
    return base, f"{base.rsplit('/', 1)[0]}/{name}", name


@asynccontextmanager
async def _scratch_database(*, converge: bool = True):
    """Yield (engine, session_factory) bound to a freshly created scratch database with the
    meeting-api mirror schema. ``converge=False`` skips the attributed-range DDL, yielding the
    pre-MIGRATION-0008 (base-image) schema. The scratch DB is dropped on exit."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    admin_url, scratch_url, scratch_name = _scratch_url(
        os.environ["MEETING_API_TEST_DATABASE_URL"]
    )
    admin = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as c:
        await c.execute(text(f'CREATE DATABASE "{scratch_name}"'))
    try:
        engine = create_async_engine(scratch_url)
        from meeting_api.sessions.models import Base
        async with engine.begin() as conn:
            # ``meetings`` carries expression indexes over the MIGRATION-0005 helper function,
            # which create_all cannot create — install it first, as admin-api's ensure_schema does.
            await conn.execute(text(
                "CREATE OR REPLACE FUNCTION meeting_event_time("
                "data jsonb, start_time timestamp, created_at timestamp"
                ") RETURNS timestamp LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$ "
                "BEGIN RETURN COALESCE("
                "((data ->> 'scheduled_at')::timestamptz AT TIME ZONE 'UTC'),"
                "start_time, created_at); "
                "EXCEPTION WHEN OTHERS THEN RETURN COALESCE(start_time, created_at); "
                "END $fn$;"))
            await conn.run_sync(Base.metadata.create_all)
        if converge:
            # Converge the range table through the production entry point — the same call the
            # app lifespan runs — so every test exercises the real DDL path.
            from meeting_api.recordings.adapters import ensure_attributed_audio_schema
            await ensure_attributed_audio_schema(engine)
        sf = async_sessionmaker(engine, expire_on_commit=False)
        yield engine, sf
        await engine.dispose()
    finally:
        # WITH (FORCE) — pg13+ terminates any pooled connection that outlived engine.dispose()
        # (a failed test can strand one, and a blocked DROP DATABASE then fails teardown).
        async with admin.connect() as c:
            await c.execute(text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)'))
        await admin.dispose()


@pytest.fixture()
async def pg():
    """(engine, session_factory) bound to a freshly created scratch database with the meeting-api
    mirror schema. The scratch DB is dropped on teardown."""
    pytest.importorskip("sqlalchemy")
    async with _scratch_database() as pair:
        yield pair


def _meta(sequence: int, key: str, pcm: bytes, *, clock_origin_ms=1000, **overrides) -> dict:
    sample_rate, channels = 16000, 1
    meta = {
        "version": 1, "meeting_id": str(MEETING_ID), "sequence": sequence,
        "idempotency_key": key, "speaker_key": f"channel:{sequence % 5}",
        "speaker_name": "", "channel": sequence % 5, "turn_generation": 1,
        "attribution": {"source": "unresolved", "confidence": 0},
        "clock_origin_ms": clock_origin_ms,
        "start_ms": sequence * 250,
        "audio_duration_ms": len(pcm) / (sample_rate * channels * 4) * 1000,
        "codec": "pcm_f32le", "sample_rate": sample_rate, "channels": channels,
        "byte_count": len(pcm), "sha256": hashlib.sha256(pcm).hexdigest(),
    }
    meta["end_ms"] = meta["start_ms"] + meta["audio_duration_ms"]
    meta.update(overrides)
    return meta


async def _seed_meeting(sf, *, status="active", data=None, meeting_id=MEETING_ID):
    from meeting_api.sessions.models import Meeting, MeetingSession

    async with sf() as db:
        db.add(Meeting(id=meeting_id, user_id=USER, platform="google_meet",
                       platform_specific_id=f"pg-test-{meeting_id}", status=status, data=data or {}))
        db.add(MeetingSession(meeting_id=meeting_id, session_uid=SESSION_UID))
        await db.commit()


async def _meeting_data(sf, meeting_id=MEETING_ID):
    from sqlalchemy import select
    from meeting_api.sessions.models import Meeting

    async with sf() as db:
        return (await db.execute(
            select(Meeting.data).where(Meeting.id == meeting_id)
        )).scalar_one()


async def _range_rows(sf, meeting_id=MEETING_ID):
    from sqlalchemy import select
    from meeting_api.sessions.models import AttributedAudioRange

    async with sf() as db:
        rows = (await db.execute(
            select(AttributedAudioRange)
            .where(AttributedAudioRange.meeting_id == meeting_id)
            .order_by(AttributedAudioRange.id)
        )).scalars().all()
        return rows


async def _table_names(engine):
    async with engine.connect() as conn:
        return set(await conn.run_sync(
            lambda c: __import__("sqlalchemy").inspect(c).get_table_names()))


async def test_concurrent_ensure_converges_once(pg):
    """N replicas booting at once must not race pg_type — review saw DuplicateTableError /
    UniqueViolation at 3–8 concurrent starts. The advisory xact lock serializes them."""
    import asyncio

    engine, sf = pg
    await _seed_meeting(sf)  # populated meetings — the FK takes ShareRowExclusiveLock on it
    from sqlalchemy import text
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE attributed_audio_ranges"))
    assert "attributed_audio_ranges" not in await _table_names(engine)

    from meeting_api.recordings.adapters import ensure_attributed_audio_schema

    results = await asyncio.gather(
        *[ensure_attributed_audio_schema(engine) for _ in range(8)],
        return_exceptions=True,
    )
    assert results == [None] * 8, results
    assert "attributed_audio_ranges" in await _table_names(engine)

    async with engine.connect() as conn:
        idx = {r[0] for r in (await conn.execute(text(
            "SELECT indexname FROM pg_indexes WHERE tablename='attributed_audio_ranges'"))).all()}
        assert idx == {"attributed_audio_ranges_pkey",
                       "uq_attributed_range_key", "uq_attributed_range_sequence"}, idx
        count = (await conn.execute(text(
            "SELECT count(*) FROM pg_class WHERE relname='attributed_audio_ranges'"))).scalar()
        assert count == 1


async def test_startup_ddl_creates_then_noops(pg):
    engine, sf = pg
    await _seed_meeting(sf)
    from meeting_api.recordings.adapters import ensure_attributed_audio_schema
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE attributed_audio_ranges"))
    assert "attributed_audio_ranges" not in await _table_names(engine)
    await ensure_attributed_audio_schema(engine)
    assert "attributed_audio_ranges" in await _table_names(engine)

    # Second call is a pure no-op (existing table + indexes → converge path).
    await ensure_attributed_audio_schema(engine)

    async with engine.connect() as conn:
        idx = {r[0] for r in (await conn.execute(text(
            "SELECT indexname FROM pg_indexes WHERE tablename='attributed_audio_ranges'"))).all()}
    assert {"uq_attributed_range_key", "uq_attributed_range_sequence"} <= idx


async def test_reserve_upload_fail_close_through_sql_ledger(pg):
    engine, sf = pg
    await _seed_meeting(sf)
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import (
        AttributedConflict, close_attributed_manifest, fail_reserved_attributed_range,
        reserve_attributed_range, upload_reserved_attributed_range,
    )
    from meeting_api.recordings.fakes import InMemoryStorage

    repo = SqlAlchemyRecordingRepo(sf)
    storage = InMemoryStorage()
    pcm = b"\x00\x00\x80?" * 4
    meta0 = _meta(0, "pg-turn-0", pcm)
    meta1 = _meta(1, "pg-turn-1", pcm)

    reserved = await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID, range_data=meta0)
    assert reserved["state"] == "sealed"

    # Idempotent replay returns the same reservation without a second row.
    replay = await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID, range_data=dict(meta0))
    assert replay["storage_path"] == reserved["storage_path"]
    assert len(await _range_rows(sf)) == 1

    # Duplicate sequence → conflict; conflicting metadata for the same key → conflict.
    with pytest.raises(AttributedConflict):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(0, "other-key", pcm))
    with pytest.raises(AttributedConflict):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=dict(meta0, speaker_name="different"))

    uploaded = await upload_reserved_attributed_range(
        repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=meta0, data=pcm)
    assert uploaded["state"] == "uploaded"
    assert len(storage.blobs) == 1

    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID, range_data=meta1)
    failed = await fail_reserved_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID, range_data=meta1)
    assert failed["state"] == "failed"

    receipt = await close_attributed_manifest(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID)
    assert receipt["state"] == "closed" and receipt["range_count"] == 2

    # meetings.data holds ONLY the header — no ranges.
    data = await _meeting_data(sf)
    assert "ranges" not in data["attributed_audio_manifest"]
    rows = await _range_rows(sf)
    assert [r.idempotency_key for r in rows] == ["pg-turn-0", "pg-turn-1"]
    assert rows[0].payload["state"] == "uploaded"
    assert rows[1].payload["state"] == "failed"

    # Owner read assembles header + rows into the v1 shape (storage_path stripped by public_manifest).
    artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
    manifest = artifact["manifest"]
    assert [r["idempotency_key"] for r in manifest["ranges"]] == ["pg-turn-0", "pg-turn-1"]

    # Closed-manifest reserve is rejected on both stacks.
    with pytest.raises(AttributedConflict):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(2, "pg-turn-2", pcm))


async def test_migration_preserves_union_order_and_never_regresses(pg):
    """Reviewer repro: inline [2, 8] where seq-8 is already a table row — a union read shows
    [2, 8] (inline first); migration must write exactly that order (not [8, 2]), and seq-8's
    inline 'sealed' twin must NOT overwrite the table row's 'uploaded' payload."""
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4
    table_row_8 = dict(_meta(8, "tbl-8", pcm, clock_origin_ms=500), state="uploaded",
                       storage_path="attributed-audio/7/1/s/8.pcm")
    await _seed_meeting(sf, data={"attributed_audio_manifest": {
        "version": 1, "meeting_id": str(MEETING_ID),
        "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open",
        "ranges": [
            dict(_meta(2, "inline-2", pcm, clock_origin_ms=500), state="uploaded",
                 storage_path="attributed-audio/7/1/s/2.pcm"),
            dict(_meta(8, "tbl-8", pcm, clock_origin_ms=500), state="sealed",
                 storage_path="attributed-audio/7/1/s/8.pcm"),
        ],
    }})
    # Seed the table row directly (a range the new image wrote before this meeting's first write).
    from meeting_api.sessions.models import AttributedAudioRange
    async with sf() as db:
        db.add(AttributedAudioRange(meeting_id=MEETING_ID, sequence=8,
                                    idempotency_key="tbl-8", payload=table_row_8))
        await db.commit()

    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    repo = SqlAlchemyRecordingRepo(sf)

    # Pre-migration read shows the union order: inline first → [2, 8].
    artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
    assert [r["sequence"] for r in artifact["manifest"]["ranges"]] == [2, 8]

    # First row-locked write triggers migration; appending seq-9 must keep the union order.
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=_meta(9, "new-9", pcm, clock_origin_ms=500))

    rows = await _range_rows(sf)
    assert [r.sequence for r in rows] == [2, 8, 9]
    # No regression: the migrated seq-8 row kept the table's uploaded payload.
    assert rows[1].payload["state"] == "uploaded"

    # Post-migration read is IDENTICAL to the pre-migration union order.
    artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
    assert [r["sequence"] for r in artifact["manifest"]["ranges"]] == [2, 8, 9]
    assert artifact["manifest"]["ranges"][1]["state"] == "uploaded"
    data = await _meeting_data(sf)
    assert "ranges" not in data["attributed_audio_manifest"]


async def test_malformed_inline_duplicates_migrate_instead_of_500(pg, caplog):
    """Opus L3: a legacy inline list carrying duplicate sequences/keys must NOT raise
    IntegrityError on every write (permanent 500 for that meeting). Migration dedups
    first-occurrence-wins and logs."""
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4
    dup_seq = [
        dict(_meta(3, "dup-a", pcm, clock_origin_ms=500), state="uploaded"),
        dict(_meta(3, "dup-b", pcm, clock_origin_ms=500), state="sealed"),
        dict(_meta(4, "dup-a", pcm, clock_origin_ms=500), state="sealed"),  # same KEY as row 0
        dict(_meta(5, "ok-5", pcm, clock_origin_ms=500), state="uploaded"),
        "not-a-dict",
    ]
    await _seed_meeting(sf, data={"attributed_audio_manifest": {
        "version": 1, "meeting_id": str(MEETING_ID),
        "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open", "ranges": dup_seq,
    }})

    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    repo = SqlAlchemyRecordingRepo(sf)
    import logging
    with caplog.at_level(logging.WARNING, logger="meeting_api.recordings.ledger"):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(6, "new-6", pcm, clock_origin_ms=500))

    rows = await _range_rows(sf)
    assert [r.sequence for r in rows] == [3, 5, 6]
    assert rows[0].idempotency_key == "dup-a"
    assert any("dropped" in rec.message for rec in caplog.records)

    # A second write hits no IntegrityError — the meeting's write path is healed.
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=_meta(7, "new-7", pcm, clock_origin_ms=500))
    assert [r.sequence for r in await _range_rows(sf)] == [3, 5, 6, 7]


async def test_owner_manifest_read_is_one_statement(pg):
    """Astra's read-shape finding: data + ranges in ONE snapshot — a deletion committing between
    two statements must never yield a closed-empty manifest. Proven by statement count."""
    engine, sf = pg
    await _seed_meeting(sf)
    from sqlalchemy import event, text
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    repo = SqlAlchemyRecordingRepo(sf)
    pcm = b"\x00\x00\x80?" * 4
    for i in range(3):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(i, f"r-{i}", pcm))

    statements = []
    def _count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(engine.sync_engine, "before_cursor_execute", _count)
    try:
        artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _count)

    assert artifact["manifest"] is not None
    assert [r["sequence"] for r in artifact["manifest"]["ranges"]] == [0, 1, 2]
    data_reads = [s for s in statements if "meetings" in s.lower() and "select" in s.lower()]
    assert len(data_reads) == 1, f"owner read must be ONE snapshot, saw: {data_reads}"


async def test_owner_read_never_surfaces_closed_empty_phantom(pg):
    """The interleaving Astra flagged: a delete commits between the old reader's two statements →
    closed manifest with zero ranges (never durably existed). The single-statement read makes the
    interleaving impossible; assert it additionally under a real concurrent delete."""
    engine, sf = pg
    await _seed_meeting(sf)
    import asyncio
    from sqlalchemy import delete as sa_delete
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range
    from meeting_api.sessions.models import AttributedAudioRange, Meeting

    repo = SqlAlchemyRecordingRepo(sf)
    pcm = b"\x00\x00\x80?" * 4
    for i in range(20):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(i, f"c-{i}", pcm))

    async def _deleter():
        async with sf() as db:
            m = (await db.execute(
                __import__("sqlalchemy").select(Meeting).where(Meeting.id == MEETING_ID)
                .with_for_update()
            )).scalars().first()
            data = dict(m.data)
            data.pop("attributed_audio_manifest", None)
            from sqlalchemy.orm.attributes import flag_modified
            m.data = data
            flag_modified(m, "data")
            await db.execute(sa_delete(AttributedAudioRange).where(
                AttributedAudioRange.meeting_id == MEETING_ID))
            await db.commit()

    async def _reader():
        seen = []
        for _ in range(50):
            artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
            seen.append(artifact["manifest"] if artifact else None)
        return seen

    reader = asyncio.create_task(_reader())
    deleter = asyncio.create_task(_deleter())
    manifests, _ = await asyncio.gather(reader, deleter)
    for manifest in manifests:
        if manifest is None:
            continue  # read raced the delete and correctly saw it gone
        assert manifest["ranges"], (
            "phantom closed-empty manifest — header survived the read while the range rows "
            "from a committed delete vanished")
        assert len(manifest["ranges"]) == 20


async def test_keyed_range_download_uses_index(pg):
    """GET /meetings/{id}/attributed-audio/ranges/{seq} must resolve through the unique index —
    not the O(ranges) manifest assembly that made staged downloads O(n²)."""
    engine, sf = pg
    await _seed_meeting(sf)
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import (
        close_attributed_manifest, reserve_attributed_range,
        upload_reserved_attributed_range,
    )
    from meeting_api.recordings.fakes import InMemoryStorage

    repo = SqlAlchemyRecordingRepo(sf)
    storage = InMemoryStorage()
    pcm = b"\x00\x00\x80?" * 4
    meta0 = _meta(0, "dl-0", pcm)
    meta1 = _meta(1, "dl-1", pcm)
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID, range_data=meta0)
    await upload_reserved_attributed_range(
        repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=meta0, data=pcm)
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID, range_data=meta1)
    await upload_reserved_attributed_range(
        repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=meta1, data=pcm)
    await close_attributed_manifest(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID)

    from sqlalchemy import event
    from meeting_api.recordings.attributed import attributed_range_for_owner

    statements = []
    def _count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(engine.sync_engine, "before_cursor_execute", _count)
    try:
        blob = await attributed_range_for_owner(
            repo, storage, user_id=USER, meeting_id=MEETING_ID, sequence=1)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _count)
    assert blob == pcm
    # One statement — and it names the unique probe columns, not a manifest scan.
    assert len(statements) == 1, statements
    assert "sequence" in statements[0] and "meetings" in statements[0]

    # Missing sequence → not found (fake storage still has both blobs).
    from meeting_api.recordings.service import SessionNotFound
    with pytest.raises(SessionNotFound):
        await attributed_range_for_owner(
            repo, storage, user_id=USER, meeting_id=MEETING_ID, sequence=99)
    # Unowned meeting → not found.
    with pytest.raises(SessionNotFound):
        await attributed_range_for_owner(
            repo, storage, user_id=999, meeting_id=MEETING_ID, sequence=0)
    # A pending artifact_deletion fences the download in the same snapshot.
    async def _settle(data):
        d = dict(data)
        d["artifact_deletion"] = {"state": "pending", "cleanup_version": 1,
                                  "requested_at": "2026-10-02T00:00:00Z"}
        return d, True
    assert await repo.mutate_meeting_data(MEETING_ID, _settle) is True
    with pytest.raises(SessionNotFound):
        await attributed_range_for_owner(
            repo, storage, user_id=USER, meeting_id=MEETING_ID, sequence=0)


async def test_rollback_folds_rows_and_drops_table(pg):
    """Both reviewers, High: the SQL rollback clobbered inline ranges (``[]`` for a never-migrated
    meeting, table-only for mixed storage). The Python entry point folds with ``union_ranges`` —
    inline positions kept — deletes the folded rows in the same transaction, and drops the table."""
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4

    # meeting 1: table-only (migrated via the real write path). meeting 2: legacy inline-only —
    # must stay byte-identical. meeting 3: mixed (inline [2] + table [8], the mid-deploy shape).
    await _seed_meeting(sf)
    legacy = [
        dict(_meta(1, "keep-1", pcm), state="uploaded"),
        dict(_meta(2, "keep-2", pcm), state="sealed"),
    ]
    await _seed_meeting(sf, data={"attributed_audio_manifest": {
        "version": 1, "meeting_id": str(MEETING_ID + 1), "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open", "ranges": legacy}}, meeting_id=MEETING_ID + 1)
    before_2 = await _meeting_data(sf, meeting_id=MEETING_ID + 1)
    await _seed_meeting(sf, data={"attributed_audio_manifest": {
        "version": 1, "meeting_id": str(MEETING_ID + 2), "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open",
        "ranges": [dict(_meta(2, "in-2", pcm), state="uploaded")]}}, meeting_id=MEETING_ID + 2)

    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range
    from meeting_api.sessions.models import AttributedAudioRange
    from sqlalchemy import insert

    repo = SqlAlchemyRecordingRepo(sf)
    for i in range(3):
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(i, f"rb-{i}", pcm))
    async with sf() as db:  # the mixed meeting's table row, appended after the inline slot
        await db.execute(insert(AttributedAudioRange).values(
            meeting_id=MEETING_ID + 2, sequence=8, idempotency_key="tbl-8",
            payload=dict(_meta(8, "tbl-8", pcm), state="uploaded")))
        await db.commit()

    from meeting_api.recordings.rollback import rollback_attributed_ranges
    stats = await rollback_attributed_ranges(sf)
    assert stats["meetings_folded"] == 2 and stats["rows_folded"] == 4

    assert "attributed_audio_ranges" not in await _table_names(engine)
    assert (await _meeting_data(sf, meeting_id=MEETING_ID + 1)) == before_2  # untouched legacy meeting
    assert [r["idempotency_key"] for r in
            (await _meeting_data(sf))["attributed_audio_manifest"]["ranges"]] == [
        "rb-0", "rb-1", "rb-2"]
    # Mixed: inline position kept, table row appended — union_ranges order.
    assert [r["idempotency_key"] for r in
            (await _meeting_data(sf, meeting_id=MEETING_ID + 2))["attributed_audio_manifest"]["ranges"]] == [
        "in-2", "tbl-8"]

    # Idempotent + resumable: a second run folds nothing and is a clean no-op.
    stats2 = await rollback_attributed_ranges(sf)
    assert stats2["table_present"] is False
    assert (await _meeting_data(sf, meeting_id=MEETING_ID + 1)) == before_2

async def test_rollback_restores_base_semantics(pg):
    """Astra P2: after rollback, the BASE image's manifest read and completed-artifact deletion
    must behave exactly as on a never-migrated database — for inline-only, table-only, mixed and
    tombstoned meetings — with no orphaned table rows (the table itself is gone)."""
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4
    from sqlalchemy import insert
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import (
        close_attributed_manifest, reserve_attributed_range,
        upload_reserved_attributed_range,
    )
    from meeting_api.recordings.fakes import InMemoryStorage
    from meeting_api.sessions.models import AttributedAudioRange

    MIDS = (MEETING_ID, MEETING_ID + 1, MEETING_ID + 2, MEETING_ID + 3)

    repo = SqlAlchemyRecordingRepo(sf)
    # m1 table-only (migrated through the real write path), m2 inline-only legacy, m3 mixed,
    # m4 tombstoned (header popped by a completed artifact deletion whose rows were left
    # behind — the crash/mid-delete shape).
    await _seed_meeting(sf)
    storage = InMemoryStorage()
    for i in range(2):
        meta_i = _meta(i, f"t-{i}", pcm)
        await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=meta_i)
        await upload_reserved_attributed_range(
            repo, storage, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=meta_i, data=pcm)
    await close_attributed_manifest(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID)
    # The folded manifest must equal what the new-image reader already serves.
    m1_expected = (await repo.attributed_artifacts_for_owner(USER, MEETING_ID))["manifest"]
    m2_header = {"version": 1, "meeting_id": str(MEETING_ID + 1),
                 "clock_origin": "first_admitted_capture_epoch_ms",
                 "clock_origin_ms": 500, "state": "closed"}
    m3_header = {"version": 1, "meeting_id": str(MEETING_ID + 2),
                 "clock_origin": "first_admitted_capture_epoch_ms",
                 "clock_origin_ms": 500, "state": "closed"}
    m2_ranges = [dict(_meta(0, "in-0", pcm), state="uploaded")]
    m3_ranges = [dict(_meta(2, "mx-2", pcm), state="sealed"),
                 dict(_meta(8, "mx-8", pcm), state="uploaded")]
    await _seed_meeting(sf, data={"attributed_audio_manifest": dict(
        m2_header, ranges=m2_ranges)}, meeting_id=MEETING_ID + 1)
    await _seed_meeting(sf, data={"attributed_audio_manifest": dict(
        m3_header, ranges=m3_ranges[:1])}, meeting_id=MEETING_ID + 2)
    await _seed_meeting(sf, data={"artifact_deletion": {
        "state": "completed", "cleanup_version": 1}}, meeting_id=MEETING_ID + 3)
    async with sf() as db:
        await db.execute(insert(AttributedAudioRange).values(
            meeting_id=MEETING_ID + 2, sequence=8, idempotency_key="mx-8",
            payload=m3_ranges[1]))
        await db.execute(insert(AttributedAudioRange).values(
            meeting_id=MEETING_ID + 3, sequence=1, idempotency_key="tomb-1",
            payload=dict(_meta(1, "tomb-1", pcm), state="uploaded")))
        await db.commit()

    # The never-migrated reference database: the same final inline manifests, NO range table.
    async with _scratch_database(converge=False) as (_be, bsf):
        await _seed_meeting(bsf, data={"attributed_audio_manifest": dict(
            m1_expected)}, meeting_id=MEETING_ID)
        await _seed_meeting(bsf, data={"attributed_audio_manifest": dict(
            m2_header, ranges=m2_ranges)}, meeting_id=MEETING_ID + 1)
        await _seed_meeting(bsf, data={"attributed_audio_manifest": dict(
            m3_header, ranges=m3_ranges)}, meeting_id=MEETING_ID + 2)
        await _seed_meeting(bsf, data={"artifact_deletion": {
            "state": "completed", "cleanup_version": 1}}, meeting_id=MEETING_ID + 3)

        from meeting_api.recordings.rollback import rollback_attributed_ranges
        await rollback_attributed_ranges(sf)
        assert "attributed_audio_ranges" not in await _table_names(engine)

        # The BASE implementation: manifest read straight out of meetings.data; deletion pops
        # the manifest key — the pre-table mutate path, which knows nothing of a range table.
        async def base_read(sfx, mid):
            return ((await _meeting_data(sfx, meeting_id=mid))
                    .get("attributed_audio_manifest"))

        async def base_delete(sfx, mid):
            from sqlalchemy import select
            from sqlalchemy.orm.attributes import flag_modified
            from meeting_api.sessions.models import Meeting
            async with sfx() as db:
                m = (await db.execute(
                    select(Meeting).where(Meeting.id == mid).with_for_update()
                )).scalars().first()
                data = dict(m.data)
                data.pop("attributed_audio_manifest", None)
                data["artifact_deletion"] = {"state": "completed", "cleanup_version": 2}
                m.data = data
                flag_modified(m, "data")
                await db.commit()

        for mid in MIDS:
            assert await base_read(sf, mid) == await base_read(bsf, mid), (
                f"meeting {mid}: rolled-back manifest differs from never-migrated")
        for mid in MIDS:
            await base_delete(sf, mid)
            await base_delete(bsf, mid)
        for mid in MIDS:
            assert await _meeting_data(sf, meeting_id=mid) == \
                await _meeting_data(bsf, meeting_id=mid)
        # m4's tombstone: the rolled-back DB shows the same completed deletion — the leftover
        # table rows were swept by the rollback, not folded back into a manifest.
        data4 = await _meeting_data(sf, meeting_id=MEETING_ID + 3)
        assert "attributed_audio_manifest" not in data4
        assert data4["artifact_deletion"]["state"] == "completed"


async def test_crossed_key_sequence_collision(pg):
    """Astra P3: inline (a,1,sealed),(b,2,sealed) + table (a,2,uploaded) — the key match and the
    sequence match point at DIFFERENT positions. The union must stay unique on both axes: the
    table's uploaded payload lands at the earliest colliding slot and the conflicting inline
    row drops; a migration must not raise UniqueViolation."""
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4
    inline = [
        dict(_meta(1, "a", pcm), state="sealed"),
        dict(_meta(2, "b", pcm), state="sealed"),
    ]
    await _seed_meeting(sf, data={"attributed_audio_manifest": {
        "version": 1, "meeting_id": str(MEETING_ID),
        "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open", "ranges": inline}})

    from sqlalchemy import insert
    from meeting_api.sessions.models import AttributedAudioRange
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    async with sf() as db:
        await db.execute(insert(AttributedAudioRange).values(
            meeting_id=MEETING_ID, sequence=2, idempotency_key="a",
            payload=dict(_meta(2, "a", pcm), state="uploaded")))
        await db.commit()

    repo = SqlAlchemyRecordingRepo(sf)
    artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
    seqs = [r["sequence"] for r in artifact["manifest"]["ranges"]]
    keys = [r["idempotency_key"] for r in artifact["manifest"]["ranges"]]
    assert len(seqs) == len(set(seqs)) and len(keys) == len(set(keys))
    assert seqs == [2]  # (a,2,uploaded) merged at the earliest slot; (b,2,sealed) dropped
    assert artifact["manifest"]["ranges"][0]["state"] == "uploaded"

    # The migrating write must not UniqueViolation — the union IS the written order.
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=_meta(9, "post", pcm, clock_origin_ms=500))
    rows = await _range_rows(sf)
    assert [(r.sequence, r.idempotency_key) for r in rows] == [(2, "a"), (9, "post")]
    assert "ranges" not in (await _meeting_data(sf))["attributed_audio_manifest"]



async def test_manifest_removal_deletes_range_rows(pg):
    engine, sf = pg
    await _seed_meeting(sf, status="completed")
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    repo = SqlAlchemyRecordingRepo(sf)
    pcm = b"\x00\x00\x80?" * 4
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=_meta(0, "doomed", pcm))
    assert len(await _range_rows(sf)) == 1

    # A mutator that pops the manifest key must drop the table rows in the same transaction.
    async def _drop(data):
        next_data = dict(data)
        next_data.pop("attributed_audio_manifest", None)
        return next_data, True

    assert await repo.mutate_meeting_data(MEETING_ID, _drop) is True
    assert await _range_rows(sf) == []
    assert "attributed_audio_manifest" not in await _meeting_data(sf)


async def test_legacy_inline_ranges_migrate_on_first_write(pg):
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4
    legacy0 = dict(_meta(0, "legacy-0", pcm, clock_origin_ms=500), state="uploaded",
                   path="/meetings/1/attributed-audio/ranges/0",
                   storage_path="attributed-audio/7/1/s/000000-abc.pcm")
    legacy1 = dict(_meta(1, "legacy-1", pcm, clock_origin_ms=500), state="failed",
                   path="/meetings/1/attributed-audio/ranges/1",
                   storage_path="attributed-audio/7/1/s/000001-def.pcm")
    await _seed_meeting(sf, data={"attributed_audio_manifest": {
        "version": 1, "meeting_id": str(MEETING_ID),
        "clock_origin": "first_admitted_capture_epoch_ms",
        "clock_origin_ms": 500, "state": "open",
        "ranges": [legacy0, legacy1],
    }})

    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    repo = SqlAlchemyRecordingRepo(sf)

    # A reserve retry for a key that exists only INLINE must be a replay — the migration runs
    # before the mutator's probes, so the key is found rather than duplicate-inserted.
    replay = await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=dict(_meta(0, "legacy-0", pcm, clock_origin_ms=500)))
    assert replay["storage_path"] == legacy0["storage_path"]

    rows = await _range_rows(sf)
    # Migration moved both inline rows into the table; the retry added none.
    assert sorted(r.idempotency_key for r in rows) == ["legacy-0", "legacy-1"]

    # New writes now land in the table; the header in meetings.data is ranges-free.
    await reserve_attributed_range(
        repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
        range_data=_meta(2, "new-turn", pcm, clock_origin_ms=500))
    data = await _meeting_data(sf)
    assert "ranges" not in data["attributed_audio_manifest"]
    assert sorted(r.idempotency_key for r in await _range_rows(sf)) == [
        "legacy-0", "legacy-1", "new-turn"]

    # Owner read still sees legacy rows first, then the new range (append order).
    artifact = await repo.attributed_artifacts_for_owner(USER, MEETING_ID)
    assert [r["idempotency_key"] for r in artifact["manifest"]["ranges"]] == [
        "legacy-0", "legacy-1", "new-turn"]


async def test_write_volume_stays_flat_as_ranges_grow(pg):
    """The TC-583 acceptance: per-reserve write volume is ~constant at ~10 ranges and ~5000
    ranges, and the meetings row stops growing with range count. The pre-TC-583 JSONB writer
    rewrote the whole manifest per op — WAL per op grew linearly and meeting 85 checkpointed
    0.5 GB of WAL every 1–2 minutes."""
    engine, sf = pg
    await _seed_meeting(sf)
    from sqlalchemy import text
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range

    repo = SqlAlchemyRecordingRepo(sf)
    pcm = b"\x00\x00\x80?" * 4
    LARGE = int(os.getenv("TC583_LARGE_N", "5000"))

    async def _reserve(seq):
        return await reserve_attributed_range(
            repo, token_meeting_id=MEETING_ID, session_uid=SESSION_UID,
            range_data=_meta(seq, f"w-{seq}", pcm))

    async def _wal_one(seq):
        """WAL bytes produced by ONE fresh reserve, on an otherwise idle database."""
        async with sf() as db:
            before = (await db.execute(
                text("SELECT pg_current_wal_lsn()"))).scalar()
        await _reserve(seq)
        async with sf() as db:
            after = (await db.execute(
                text("SELECT pg_current_wal_lsn()"))).scalar()
            return (await db.execute(text("SELECT pg_wal_lsn_diff(:a,:b)"),
                                     {"a": after, "b": before})).scalar()

    async def _meetings_data_bytes():
        async with sf() as db:
            return (await db.execute(text(
                "SELECT pg_column_size(data) FROM meetings WHERE id=:m"),
                {"m": MEETING_ID})).scalar()

    # Early sample: ~10 ranges present.
    seq = 0
    for _ in range(10):
        await _reserve(seq); seq += 1
    wal_early = sum([await _wal_one(seq + i) for i in range(3)]) / 3
    seq += 3
    size_early = await _meetings_data_bytes()

    # Grow to ~LARGE ranges cheaply (bulk insert into the table directly).
    from meeting_api.sessions.models import AttributedAudioRange
    bulk = LARGE - seq
    async with sf() as db:
        db.add_all([
            AttributedAudioRange(
                meeting_id=MEETING_ID, sequence=seq + i,
                idempotency_key=f"w-{seq + i}",
                payload=_meta(seq + i, f"w-{seq + i}", pcm))
            for i in range(bulk)
        ])
        await db.commit()
    seq += bulk

    wal_late = sum([await _wal_one(seq + i) for i in range(3)]) / 3
    size_late = await _meetings_data_bytes()

    print(f"\nTC583 write volume: wal/reserve @~10={wal_early:.0f}B "
          f"@~{LARGE}={wal_late:.0f}B · meetings.data={size_early}B→{size_late}B")

    assert size_late <= size_early * 1.5 + 1024, (
        f"meetings.data must not grow with range count: {size_early}B -> {size_late}B")
    # Late per-reserve WAL roughly equals early — the JSONB rewrite scaled LINEARLY (meeting 85:
    # ~5000 ops against a manifest closing at 2 MB ⇒ MB-scale WAL per op). Allow 3x headroom for
    # index-page splits and autovacuum noise on the fresh rows.
    assert wal_late <= max(wal_early * 3, wal_early + 8192), (
        f"per-reserve WAL grew with range count: {wal_early:.0f}B -> {wal_late:.0f}B")


async def test_r5_stale_slot_repros_through_read_migrate_rollback(pg):
    """Astra R5 (silent loss): inline (a,1,sealed) + table (a,2,uploaded),(b,1,uploaded) must
    keep BOTH table rows through read, migration and rollback. Opus R5 (crash): inline
    (a,2),(d,1),(b,0) + table (b,1),(a,0),(d,2) must merge cleanly — union, migration and
    rollback all agree."""
    engine, sf = pg
    pcm = b"\x00\x00\x80?" * 4
    from sqlalchemy import insert, select
    from sqlalchemy.orm.attributes import flag_modified
    from meeting_api.sessions.models import AttributedAudioRange, Meeting
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import reserve_attributed_range
    from meeting_api.recordings.rollback import rollback_attributed_ranges

    async def seed_case(mid, inline, table):
        await _seed_meeting(sf, data={"attributed_audio_manifest": {
            "version": 1, "meeting_id": str(mid),
            "clock_origin": "first_admitted_capture_epoch_ms",
            "clock_origin_ms": 500, "state": "open", "ranges": inline}},
            meeting_id=mid)
        async with sf() as db:
            for row in table:
                await db.execute(insert(AttributedAudioRange).values(
                    meeting_id=mid, sequence=row["sequence"],
                    idempotency_key=row["idempotency_key"], payload=dict(row)))
            await db.commit()

    repo = SqlAlchemyRecordingRepo(sf)

    # --- Astra's silent-loss repro -------------------------------------------------------
    mid = MEETING_ID
    seed_inline = [dict(_meta(1, "a", pcm), state="sealed")]
    seed_table = [dict(_meta(2, "a", pcm), state="uploaded"),
                  dict(_meta(1, "b", pcm), state="uploaded")]
    await seed_case(mid, seed_inline, seed_table)
    artifact = await repo.attributed_artifacts_for_owner(USER, mid)
    assert [(r["idempotency_key"], r["sequence"]) for r in
            artifact["manifest"]["ranges"]] == [("a", 2), ("b", 1)]

    # The migrating write must persist BOTH table rows — (b,1) must not vanish.
    await reserve_attributed_range(
        repo, token_meeting_id=mid, session_uid=SESSION_UID,
        range_data=_meta(9, "post", pcm, clock_origin_ms=500))
    rows = await _range_rows(sf, meeting_id=mid)
    assert [(r.idempotency_key, r.sequence) for r in rows] == [
        ("a", 2), ("b", 1), ("post", 9)]

    # Rollback folds the union back — (b,1) reappears inline, table is dropped.
    stats = await rollback_attributed_ranges(sf)
    assert stats["meetings_folded"] >= 1
    data = await _meeting_data(sf, meeting_id=mid)
    assert [(r["idempotency_key"], r["sequence"]) for r in
            data["attributed_audio_manifest"]["ranges"]] == [("a", 2), ("b", 1), ("post", 9)]
    assert "attributed_audio_ranges" not in await _table_names(engine)

    # --- Opus's crash repro (fresh scratch DB, still converged) --------------------------
    async with _scratch_database() as (e2, sf2):
        repo2 = SqlAlchemyRecordingRepo(sf2)
        mid2 = MEETING_ID
        await _seed_meeting(sf2, data={"attributed_audio_manifest": {
            "version": 1, "meeting_id": str(mid2),
            "clock_origin": "first_admitted_capture_epoch_ms",
            "clock_origin_ms": 500, "state": "open",
            "ranges": [dict(_meta(2, "a", pcm), state="sealed"),
                       dict(_meta(1, "d", pcm), state="sealed"),
                       dict(_meta(0, "b", pcm), state="sealed")]}}, meeting_id=mid2)
        async with sf2() as db:
            for row in [dict(_meta(1, "b", pcm), state="sealed"),
                        dict(_meta(0, "a", pcm), state="sealed"),
                        dict(_meta(2, "d", pcm), state="sealed")]:
                await db.execute(insert(AttributedAudioRange).values(
                    meeting_id=mid2, sequence=row["sequence"],
                    idempotency_key=row["idempotency_key"], payload=dict(row)))
            await db.commit()

        artifact = await repo2.attributed_artifacts_for_owner(USER, mid2)
        assert [(r["idempotency_key"], r["sequence"]) for r in
                artifact["manifest"]["ranges"]] == [("b", 1), ("a", 0), ("d", 2)]

        # Rollback on the UNMIGRATED mixed state folds the union — the three crossed inline
        # rows are displaced (all three table payloads survive) and counted.
        stats = await rollback_attributed_ranges(sf2)
        assert stats["meetings_folded"] == 1 and stats["dropped"] == 3
        data = await _meeting_data(sf2, meeting_id=mid2)
        assert [(r["idempotency_key"], r["sequence"]) for r in
                data["attributed_audio_manifest"]["ranges"]] == [
            ("b", 1), ("a", 0), ("d", 2)]
        assert "attributed_audio_ranges" not in await _table_names(e2)

        # The same union migrates cleanly when the table is converged again — the order the
        # read served is the order the durable table keeps.
        from meeting_api.recordings.adapters import ensure_attributed_audio_schema
        await ensure_attributed_audio_schema(e2)
        await reserve_attributed_range(
            repo2, token_meeting_id=mid2, session_uid=SESSION_UID,
            range_data=_meta(9, "post", pcm, clock_origin_ms=500))
        rows = await _range_rows(sf2, meeting_id=mid2)
        assert [(r.idempotency_key, r.sequence) for r in rows] == [
            ("b", 1), ("a", 0), ("d", 2), ("post", 9)]
        assert "ranges" not in (await _meeting_data(sf2, meeting_id=mid2))[
            "attributed_audio_manifest"]


async def test_r6_crossed_identity_repros_through_read_migrate_rollback(pg):
    """Round-6 reviewer counterexamples — every inline row whose key OR sequence collides with
    the table under a DIFFERENT pairing is dropped (the union never duplicates an axis, never
    resurrects a stale reservation):

    Astra R6a — inline (b,2,up),(a,1,up) + table (c,1,sealed),(a,2,sealed) -> [(c,1),(a,2)]:
      the uploaded inline (b,2) still drops — an unrelated inline row cannot consume the slot.
    Astra R6b — inline (a,1,up) + table (a,2,sealed),(b,1,up) -> [(a,2),(b,1)]: the table row
      (a,2) survives although its would-be blocker was displaced.
    Opus L7 — inline (k1,2,failed) + table (k1,0,sealed),(k0,2,failed) -> [(k1,0),(k0,2)].
    """
    pcm = b"\x00\x00\x80?" * 4
    from sqlalchemy import insert
    from meeting_api.sessions.models import AttributedAudioRange
    from meeting_api.recordings.adapters import (
        SqlAlchemyRecordingRepo, ensure_attributed_audio_schema)
    from meeting_api.recordings.attributed import reserve_attributed_range
    from meeting_api.recordings.rollback import rollback_attributed_ranges

    cases = [
        ("r6a", [dict(_meta(2, "b", pcm), state="uploaded"),
                 dict(_meta(1, "a", pcm), state="uploaded")],
                [dict(_meta(1, "c", pcm), state="sealed"),
                 dict(_meta(2, "a", pcm), state="sealed")],
                [("c", 1), ("a", 2)], 2),
        ("r6b", [dict(_meta(1, "a", pcm), state="uploaded")],
                [dict(_meta(2, "a", pcm), state="sealed"),
                 dict(_meta(1, "b", pcm), state="uploaded")],
                [("a", 2), ("b", 1)], 1),
        ("l7",  [dict(_meta(2, "k1", pcm), state="failed")],
                [dict(_meta(0, "k1", pcm), state="sealed"),
                 dict(_meta(2, "k0", pcm), state="failed")],
                [("k1", 0), ("k0", 2)], 1),
    ]
    for label, inline, table, union, n_dropped in cases:
        async with _scratch_database() as (e2, sf2):
            repo2 = SqlAlchemyRecordingRepo(sf2)
            mid = MEETING_ID
            await _seed_meeting(sf2, data={"attributed_audio_manifest": {
                "version": 1, "meeting_id": str(mid),
                "clock_origin": "first_admitted_capture_epoch_ms",
                "clock_origin_ms": 500, "state": "open",
                "ranges": [dict(r, clock_origin_ms=500) for r in inline]}},
                meeting_id=mid)
            async with sf2() as db:
                for row in table:
                    await db.execute(insert(AttributedAudioRange).values(
                        meeting_id=mid, sequence=row["sequence"],
                        idempotency_key=row["idempotency_key"], payload=dict(row)))
                await db.commit()

            artifact = await repo2.attributed_artifacts_for_owner(USER, mid)
            assert [(r["idempotency_key"], r["sequence"]) for r in
                    artifact["manifest"]["ranges"]] == union, label

            # Rollback on the un-migrated mixed state folds the union — the crossed inline
            # rows are dropped and counted.
            stats = await rollback_attributed_ranges(sf2)
            assert stats["meetings_folded"] == 1, label
            assert stats["dropped"] == n_dropped, label
            data = await _meeting_data(sf2, meeting_id=mid)
            assert [(r["idempotency_key"], r["sequence"]) for r in
                    data["attributed_audio_manifest"]["ranges"]] == union, label

            # A write after re-creating the table migrates the same union — no IntegrityError.
            await ensure_attributed_audio_schema(e2)
            await reserve_attributed_range(
                repo2, token_meeting_id=mid, session_uid=SESSION_UID,
                range_data=_meta(9, "post", pcm, clock_origin_ms=500))
            rows = await _range_rows(sf2, meeting_id=mid)
            assert [(r.idempotency_key, r.sequence) for r in rows] == union + [
                ("post", 9)], label
            assert "ranges" not in (await _meeting_data(sf2, meeting_id=mid))[
                "attributed_audio_manifest"], label


async def test_r7_keyed_download_honors_crossed_identity(pg):
    """Astra P2 / Opus L7 keyed-path repros — the crossed inline row the manifest drops must
    NOT download, before AND after migration:

    R7a: inline (a,1,uploaded) + table (a,2,uploaded) — the manifest lists only seq 2, but the
    old keyed read served seq 1's inline bytes until the table check was added.
    R7b: inline (x,5,uploaded) + table (x,1,uploaded) — same flaw with distant sequences.
    """
    pcm = b"\x00\x00\x80?" * 4
    from sqlalchemy import insert
    from meeting_api.sessions.models import AttributedAudioRange
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import (
        attributed_range_for_owner, attributed_manifest_for_owner)
    from meeting_api.recordings.fakes import InMemoryStorage
    from meeting_api.recordings.service import SessionNotFound

    cases = [
        ("r7a", [dict(_meta(1, "a", pcm), state="uploaded",
                      storage_path="attributed-audio/7/1/a/1.pcm")],
                [dict(_meta(2, "a", pcm), state="uploaded",
                      storage_path="attributed-audio/7/1/a/2.pcm")],
                1, 2),
        ("r7b", [dict(_meta(5, "x", pcm), state="uploaded",
                      storage_path="attributed-audio/7/1/x/5.pcm")],
                [dict(_meta(1, "x", pcm), state="uploaded",
                      storage_path="attributed-audio/7/1/x/1.pcm")],
                5, 1),
    ]
    for label, inline, table, dropped_seq, kept_seq in cases:
        async with _scratch_database() as (e2, sf2):
            repo = SqlAlchemyRecordingRepo(sf2)
            storage = InMemoryStorage()
            mid = MEETING_ID
            for row in inline + table:
                storage.blobs[row["storage_path"]] = pcm
            await _seed_meeting(sf2, data={"attributed_audio_manifest": {
                "version": 1, "meeting_id": str(mid),
                "clock_origin": "first_admitted_capture_epoch_ms",
                "clock_origin_ms": 500, "state": "closed",
                "ranges": inline}}, meeting_id=mid)
            async with sf2() as db:
                for row in table:
                    await db.execute(insert(AttributedAudioRange).values(
                        meeting_id=mid, sequence=row["sequence"],
                        idempotency_key=row["idempotency_key"], payload=dict(row)))
                await db.commit()

            # The manifest excludes the crossed row; the keyed download must agree — the
            # request never hit migration.
            manifest = await attributed_manifest_for_owner(repo, user_id=USER, meeting_id=mid)
            assert [(r["idempotency_key"], r["sequence"]) for r in
                    manifest["ranges"]] == [(inline[0]["idempotency_key"], kept_seq)], label
            with pytest.raises(SessionNotFound):
                await attributed_range_for_owner(
                    repo, storage, user_id=USER, meeting_id=mid, sequence=dropped_seq)
            # The surviving union row still downloads its own bytes.
            assert await attributed_range_for_owner(
                repo, storage, user_id=USER, meeting_id=mid, sequence=kept_seq) == pcm, label

            # Force the lazy migration (a no-op mutation under the row lock writes the union
            # into the table and strips the inline list) — the answer must not change.
            async def _noop(data):
                return dict(data), True
            assert await repo.mutate_meeting_data(mid, _noop) is True
            assert "ranges" not in (await _meeting_data(sf2, meeting_id=mid))[
                "attributed_audio_manifest"], label
            with pytest.raises(SessionNotFound):
                await attributed_range_for_owner(
                    repo, storage, user_id=USER, meeting_id=mid, sequence=dropped_seq)
            assert await attributed_range_for_owner(
                repo, storage, user_id=USER, meeting_id=mid, sequence=kept_seq) == pcm, label


async def test_r8_keyed_download_matches_full_union(pg):
    """Round-8 review: the keyed download must equal the manifest row at each sequence —
    computed by union_ranges over the SAME inputs (full inline list + whole table), never by
    special-casing. Seeded parity over malformed duplicate inline rows, crossed identities,
    and merge losers, before AND after migration.

    Reviewer repros embedded: Opus 11/1009 seq 5 (dup key + crossed); Astra inline
    (a,1),(a,2) + table (b,2) → seq 2 serves the table row; Astra inline (a,1),(a,2) +
    table (b,1) → seq 2 serves surviving inline (a,2); Opus 1016 seq 3 (dup sequence:
    (d,3) dropped, (c,3,uploaded) serves).
    """
    pcm = b"\x00\x00\x80?" * 4
    pcm2 = b"\x00\x00\x80?" * 8
    from sqlalchemy import insert
    from meeting_api.sessions.models import AttributedAudioRange
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import (
        attributed_range_for_owner, attributed_manifest_for_owner)
    from meeting_api.recordings.fakes import InMemoryStorage
    from meeting_api.recordings.service import SessionNotFound

    def row(seq, key, path, state="uploaded"):
        return dict(_meta(seq, key, pcm), state=state, storage_path=path)

    cases = [
        # Astra: dup inline keys, key collides with table on neither/both axes — seq 2 has a
        # table row in the first case, only the surviving inline row in the second.
        ("dups-b2", [row(1, "a", "attributed-audio/1/m/in1.pcm"),
                     row(2, "a", "attributed-audio/1/m/in2.pcm")],
                    [row(2, "b", "attributed-audio/1/m/tb2.pcm")]),
        ("dups-b1", [row(1, "a", "attributed-audio/1/m/in1.pcm"),
                     row(2, "a", "attributed-audio/1/m/in2.pcm")],
                    [row(1, "b", "attributed-audio/1/m/tb1.pcm")]),
        # Opus 1016: duplicate inline sequence — first inline at seq 3 drops on the table's
        # (d,9); the second inline at seq 3 still serves.
        ("dup-seq", [row(3, "d", "attributed-audio/1/m/d3.pcm"),
                     row(3, "c", "attributed-audio/1/m/c3.pcm")],
                    [row(9, "d", "attributed-audio/1/m/t9.pcm")]),
        # Opus 11/1009: crossed dup — (a,5) and (a,7) inline with table (a,9),(d,5): seq 5's
        # candidate drops (crossed), the table row (d,5) serves.
        ("opus-1009", [row(5, "a", "attributed-audio/1/m/a5.pcm"),
                       row(7, "a", "attributed-audio/1/m/a7.pcm")],
                      [row(9, "a", "attributed-audio/1/m/t9.pcm"),
                       row(5, "d", "attributed-audio/1/m/d5.pcm")]),
        # Same-identity merge at seq 1 (failed inline vs uploaded table) + a non-uploaded
        # survivor (failed → 404) + a clean table row.
        ("mixed", [row(1, "m", "attributed-audio/1/m/m1.pcm", state="failed"),
                   row(2, "m2", "attributed-audio/1/m/m2.pcm"),
                   row(4, "f", "attributed-audio/1/m/f4.pcm", state="failed")],
                  [row(1, "m", "attributed-audio/1/m/m1t.pcm"),
                   row(3, "n", "attributed-audio/1/m/n3.pcm")]),
        # A malformed non-dict inline row rides along; union drops it, reads unaffected.
        ("malformed", [row(1, "a", "attributed-audio/1/m/in1.pcm"), "not-a-dict"],
                      [row(2, "b", "attributed-audio/1/m/tb2.pcm")]),
    ]

    for label, inline, table in cases:
        async with _scratch_database() as (e2, sf2):
            repo = SqlAlchemyRecordingRepo(sf2)
            storage = InMemoryStorage()
            mid = MEETING_ID
            for r in inline + table:
                if isinstance(r, dict):
                    storage.blobs[r["storage_path"]] = pcm2
            await _seed_meeting(sf2, data={"attributed_audio_manifest": {
                "version": 1, "meeting_id": str(mid),
                "clock_origin": "first_admitted_capture_epoch_ms",
                "clock_origin_ms": 500, "state": "closed",
                "ranges": [dict(r) if isinstance(r, dict) else r for r in inline]}},
                meeting_id=mid)
            async with sf2() as db:
                for r in table:
                    await db.execute(insert(AttributedAudioRange).values(
                        meeting_id=mid, sequence=r["sequence"],
                        idempotency_key=r["idempotency_key"], payload=dict(r)))
                await db.commit()

            manifest = await attributed_manifest_for_owner(repo, user_id=USER, meeting_id=mid)
            listed = {r["sequence"]: r for r in manifest["ranges"]}

            async def check_parity():
                for seq in range(12):
                    try:
                        blob = await attributed_range_for_owner(
                            repo, storage, user_id=USER, meeting_id=mid, sequence=seq)
                    except SessionNotFound:
                        blob = None
                    if seq not in listed:
                        assert blob is None, f"{label}: seq {seq} served but not listed"
                        continue
                    expected = listed[seq]
                    if expected["state"] == "uploaded":
                        # storage_path is stripped from the public manifest — look the row up
                        # in the repo's union (unstripped) instead.
                        artifact = await repo.attributed_artifacts_for_owner(USER, mid)
                        raw = next(r for r in artifact["manifest"]["ranges"]
                                   if r["sequence"] == seq)
                        want = storage.blobs[raw["storage_path"]]
                        assert blob == want, f"{label}: seq {seq} wrong bytes"
                    else:
                        assert blob is None, (
                            f"{label}: seq {seq} state={expected['state']} served")

            # Pre-migration parity: the download answers the union even on corrupt inline
            # input.
            await check_parity()

            # Post-migration parity: identical answers on the bounded keyed path.
            async def _noop(data):
                return dict(data), True
            assert await repo.mutate_meeting_data(mid, _noop) is True
            assert "ranges" not in (await _meeting_data(sf2, meeting_id=mid))[
                "attributed_audio_manifest"], label
            await check_parity()
