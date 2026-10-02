"""TC-583 — real-Postgres conformance for the attributed range table.

The offline venv deliberately has no SQLAlchemy (adapters lazy-import it), so the fake suite can
never prove the ``SqlRangeLedger`` write path. These tests run only when
``MEETING_API_TEST_DATABASE_URL`` is set and sqlalchemy+asyncpg are importable — same convention
as ``test_single_flight.test_pg_advisory_lock_runs_on_real_postgres``.

Proves, against real Postgres:

  * ``ensure_attributed_audio_schema`` creates ``attributed_audio_ranges`` + indexes and is a
    no-op second call (the startup DDL meeting-api now runs in its lifespan);
  * reserve → upload → fail → close through ``SqlAlchemyRecordingRepo.mutate_meeting_data``:
    ranges land as table rows, ``meetings.data`` keeps only the manifest header, and readers
    assemble the same attributed-audio.v1 manifest;
  * lazy migration: a meeting whose manifest still carries inline ``ranges`` migrates them into
    the table on the first row-locked write — and a reserve retry for a key that exists only
    inline is a REPLAY, not a duplicate;
  * delete_on_removal: popping the manifest key deletes the meeting's table rows in the same tx;
  * per-operation write volume stays FLAT as ranges grow: meetings-row byte size constant and
    WAL bytes per reserve roughly equal at range ~10 and range ~5000 — the quadratic-rewrite
    failure mode (meeting 85) is gone.
"""
from __future__ import annotations

import hashlib
import os

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


@pytest.fixture()
async def pg(tmp_path):
    """A real async engine + session factory against MEETING_API_TEST_DATABASE_URL, with the
    meeting-api mirror schema created. Yields (engine, session_factory); disposes after."""
    sqlalchemy = pytest.importorskip("sqlalchemy")
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from meeting_api.sessions.models import Base

    engine = create_async_engine(os.environ["MEETING_API_TEST_DATABASE_URL"])
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        # ``meetings`` carries expression indexes over the MIGRATION-0005 helper function,
        # which create_all cannot create — install the function first, exactly as admin-api's
        # ensure_schema does.
        from sqlalchemy import text
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
    sf = async_sessionmaker(engine, expire_on_commit=False)
    yield engine, sf
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


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


async def _seed_meeting(sf, *, status="active", data=None):
    from meeting_api.sessions.models import Meeting, MeetingSession

    async with sf() as db:
        db.add(Meeting(id=MEETING_ID, user_id=USER, platform="google_meet",
                       platform_specific_id="pg-test", status=status, data=data or {}))
        db.add(MeetingSession(meeting_id=MEETING_ID, session_uid=SESSION_UID))
        await db.commit()


async def _meeting_data(sf):
    from sqlalchemy import select
    from meeting_api.sessions.models import Meeting

    async with sf() as db:
        return (await db.execute(
            select(Meeting.data).where(Meeting.id == MEETING_ID)
        )).scalar_one()


async def _range_rows(sf):
    from sqlalchemy import select
    from meeting_api.sessions.models import AttributedAudioRange

    async with sf() as db:
        rows = (await db.execute(
            select(AttributedAudioRange)
            .where(AttributedAudioRange.meeting_id == MEETING_ID)
            .order_by(AttributedAudioRange.id)
        )).scalars().all()
        return rows


async def _table_names(engine):
    async with engine.connect() as conn:
        return set(await conn.run_sync(lambda c: __import__("sqlalchemy").inspect(c).get_table_names()))


async def test_startup_ddl_creates_then_noops(pg):
    engine, sf = pg
    from sqlalchemy import text

    async with engine.begin() as conn:
        # Drop just the range table so the startup converger has work to do.
        await conn.execute(text("DROP TABLE IF EXISTS attributed_audio_ranges"))

    from meeting_api.recordings.adapters import ensure_attributed_audio_schema

    assert "attributed_audio_ranges" not in await _table_names(engine)
    await ensure_attributed_audio_schema(engine)
    assert "attributed_audio_ranges" in await _table_names(engine)

    # Second call is a pure no-op (existing table + indexes → converge path).
    await ensure_attributed_audio_schema(engine)

    # The unique invariants exist by name.
    async with engine.connect() as conn:
        idx = {r[0] for r in (await conn.execute(text(
            "SELECT indexname FROM pg_indexes WHERE tablename='attributed_audio_ranges'"))).all()}
    assert {"uq_attributed_range_key", "uq_attributed_range_sequence"} <= idx


async def test_reserve_upload_fail_close_through_sql_ledger(pg):
    engine, sf = pg
    await _seed_meeting(sf)
    from meeting_api.recordings.adapters import SqlAlchemyRecordingRepo
    from meeting_api.recordings.attributed import (
        close_attributed_manifest, fail_reserved_attributed_range,
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
    from meeting_api.recordings.attributed import AttributedConflict
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
            await db.execute(text("SELECT pg_current_wal_lsn()"))
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
