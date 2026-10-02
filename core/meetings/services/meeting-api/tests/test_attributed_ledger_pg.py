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
