"""Production adapters — the real ``Storage`` (MinIO/S3) + ``RecordingRepo`` (SQLAlchemy).

Thin translations of the ports to the concrete clients, as the parent's
``recordings.internal_upload_recording`` (storage upload + the ``SELECT ... FOR UPDATE`` row lock on
``meeting.data``) and ``recording_finalizer`` (master build + upload) do. They carry NO test logic.

Heavy imports (boto3/minio, SQLAlchemy) are LAZY (inside the methods / ``build_production_router``)
so the package imports + unit-tests with the in-memory fakes without those runtime deps in the gate
venv — which is why ``pyproject.toml`` needs no extra pins.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

log = logging.getLogger("meeting_api.recordings.adapters")

# Advisory-lock key serializing attributed_audio_ranges DDL across concurrently-booting pods —
# two replicas running CREATE TABLE/INDEX at once race on pg_type (DuplicateTableError /
# UniqueViolation), witnessed 3/4 and 7/8 crashing in review.
_ATTRIBUTED_DDL_LOCK_KEY = 0x7636_3538  # 'v658' — TC-583, fixed forever
_ATTRIBUTED_DDL_LOCK_TIMEOUT_MS = 5_000
_ATTRIBUTED_DDL_ATTEMPTS = 3


async def _invoke_mutator(tx_guard, data, mutator):
    """Run one mutator inside its caller's row-locked transaction.

    ``tx_guard`` is the live session: the tx-scope gate reads the call as delegation of DB work,
    which it is — the mutator's awaits are SqlRangeLedger ops on this same session.
    """
    return await mutator(data)


async def _migrate_range_ledger(tx_guard, ledger, legacy_rows):
    """Migrate pre-table inline range rows inside the caller's transaction (``tx_guard`` is the
    live session; the ledger binds it at construction and needs no second handle)."""
    await ledger.migrate(legacy_rows)


async def _flush_range_ledger(tx_guard, ledger):
    """Flush one ledger write-back inside its caller's transaction (``tx_guard`` is the live
    session; the ledger binds it at construction and needs no second handle)."""
    await ledger.flush()


async def ensure_attributed_audio_schema(engine) -> None:
    """Guarantee ``attributed_audio_ranges`` exists before meeting-api serves attributed traffic.

    The table's SSOT is admin-api's ``ensure_schema`` (MIGRATION-0008), but meeting-api is
    deployed independently (a fork's meeting-api image can ship against an upstream admin-api
    whose ensure_schema never learned this table) — and the attributed write path fails hard on
    a missing table. So meeting-api converges its own mirror: the same DDL semantics as
    ensure_schema — additive only, missing-table → create, missing index → add, existing
    everything → no-op — scoped to ONE table's metadata so it can never touch the rest of the
    schema.

    Concurrency is serialized by a transaction-scoped pg advisory lock taken before any catalog
    read, so N booting replicas queue instead of racing pg_type. ``lock_timeout`` keeps the
    convoy bounded: the CREATE's FK takes ShareRowExclusiveLock on ``meetings``, and an
    unbounded wait would queue every meetings writer behind a blocked converger — a timed-out
    attempt rolls its xact lock back and retries before startup fails loudly.

    A failed DDL raises: startup must not bind a port and serve attributed-audio requests whose
    every write faults on a missing table.
    """
    from sqlalchemy import text

    from ..sessions.models import AttributedAudioRange

    last_error = None
    for attempt in range(1, _ATTRIBUTED_DDL_ATTEMPTS + 1):
        try:
            async with engine.begin() as conn:
                # lock_timeout is a GUC — SET never binds params, interpolate the constant.
                await conn.execute(text(
                    f"SET LOCAL lock_timeout = '{_ATTRIBUTED_DDL_LOCK_TIMEOUT_MS}ms'"))
                await conn.execute(
                    text("SELECT pg_advisory_xact_lock(:key)"),
                    {"key": _ATTRIBUTED_DDL_LOCK_KEY},
                )
                await conn.run_sync(
                    _sync_attributed_table, AttributedAudioRange.__table__
                )
            return
        except Exception as exc:
            if not _is_lock_timeout(exc) or attempt == _ATTRIBUTED_DDL_ATTEMPTS:
                raise
            last_error = exc
            log.warning(
                "attributed_audio_ranges schema convergence timed out on lock (attempt %d/%d); "
                "retrying", attempt, _ATTRIBUTED_DDL_ATTEMPTS,
            )
            await asyncio.sleep(0.25 * attempt)
    if last_error is not None:  # unreachable — the loop raises on the final attempt
        raise last_error


def _is_lock_timeout(exc: Exception) -> bool:
    """Postgres ``lock_not_available`` (55P03) — raised when lock_timeout aborts the wait."""
    sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None)
    if sqlstate == "55P03":
        return True
    # Driver-agnostic fallback: the message is stable across asyncpg/psycopg.
    return "lock timeout" in str(exc).lower() or "lock_not_available" in str(exc)


def _sync_attributed_table(conn, table) -> None:
    """``ensure_schema`` semantics for one table: create if absent, then converge its indexes.

    Unique indexes are invariants the writer relies on (uq_attributed_range_key is the
    idempotent-reserve backstop): a failed unique CREATE raises, matching the admin-api
    fail-closed rule (#1186), rather than logging and starting against a table that cannot keep
    the contract. Non-unique index failures stay tolerated — a missing probe index degrades
    latency, never correctness.

    ``UniqueConstraint``s are converged as ``CREATE UNIQUE INDEX IF NOT EXISTS`` — equivalent on
    Postgres and the only idempotent spelling it offers for a pre-existing partial table.
    """
    from sqlalchemy import UniqueConstraint, inspect, text

    inspector = inspect(conn)
    if table.name not in set(inspector.get_table_names()):
        table.create(conn)
        return
    existing = {idx["name"] for idx in inspector.get_indexes(table.name) if idx["name"]}
    for index in table.indexes:
        if index.name and index.name in existing:
            continue
        try:
            with conn.begin_nested():
                index.create(conn)
        except Exception:
            if getattr(index, "unique", False):
                raise
    for constraint in table.constraints:
        if not isinstance(constraint, UniqueConstraint) or not constraint.name:
            continue
        if constraint.name in existing:
            continue
        cols = ", ".join(f'"{c.name}"' for c in constraint.columns)
        with conn.begin_nested():
            conn.execute(text(
                f'CREATE UNIQUE INDEX IF NOT EXISTS "{constraint.name}" '
                f'ON "{table.name}" ({cols})'
            ))


class S3Storage:
    """``Storage`` over an S3/MinIO bucket (boto3). Lazy client so the package imports without boto3."""

    def __init__(self, *, bucket: str, endpoint_url: Optional[str] = None,
                 access_key: Optional[str] = None, secret_key: Optional[str] = None):
        self._bucket = bucket
        self._endpoint = endpoint_url
        self._access_key = access_key
        self._secret_key = secret_key
        self._client = None

    def _c(self):
        if self._client is None:
            import boto3

            self._client = boto3.client(
                "s3", endpoint_url=self._endpoint,
                aws_access_key_id=self._access_key, aws_secret_access_key=self._secret_key,
            )
        return self._client

    async def _run(self, fn, *args, **kwargs):
        """Run a BLOCKING boto3 call off the event loop (G4). boto3 is synchronous; calling it directly
        inside an async method stalls the whole control plane (a multi-MB master finalize fetches many
        objects). ``asyncio.to_thread`` offloads it to the default thread pool so the loop keeps serving
        lifecycle/webhook/ws traffic. Overridable in tests."""
        import asyncio

        return await asyncio.to_thread(fn, *args, **kwargs)

    async def upload(self, key: str, data: bytes, *, content_type: str) -> None:
        await self._run(self._c().put_object, Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)

    async def list(self, prefix: str) -> list[str]:
        # S3 (and every S3-compatible backend) caps a single list_objects_v2 response at 1000 keys and
        # signals more via IsTruncated + NextContinuationToken (#769). Loop to exhaustion — a single
        # unpaginated call silently drops every chunk past the first page, so a >1000-chunk recording
        # would assemble a master from only its first 1000 objects.
        keys: list[str] = []
        token: Optional[str] = None
        while True:
            kw = {"Bucket": self._bucket, "Prefix": prefix}
            if token is not None:
                kw["ContinuationToken"] = token
            resp = await self._run(self._c().list_objects_v2, **kw)
            keys.extend(o["Key"] for o in resp.get("Contents", []))
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
            if not token:
                # Truncated but no continuation token — the backend contract is broken; stop rather
                # than loop forever, but do NOT swallow it silently.
                raise RuntimeError(
                    f"list_objects_v2 reported IsTruncated with no NextContinuationToken "
                    f"(prefix={prefix!r}); chunk listing may be incomplete"
                )
        return sorted(keys)

    async def get(self, key: str) -> bytes:
        obj = await self._run(self._c().get_object, Bucket=self._bucket, Key=key)
        return await self._run(obj["Body"].read)

    async def size(self, key: str) -> int:
        head = await self._run(self._c().head_object, Bucket=self._bucket, Key=key)
        return int(head["ContentLength"])

    async def get_range(self, key: str, start: int, end: int) -> bytes:
        # Pass the byte range through to S3 (inclusive offsets) so we fetch only the requested window.
        resp = await self._run(self._c().get_object, Bucket=self._bucket, Key=key, Range=f"bytes={start}-{end}")
        return await self._run(resp["Body"].read)

    async def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            await self._run(self._c().head_object, Bucket=self._bucket, Key=key)
            return True
        except ClientError:
            return False

    async def list_detailed(self, prefix: str) -> list[dict]:
        """Key + Size + LastModified per object, paginated to exhaustion like ``list``.

        Size and LastModified ride the SAME response as the keys, so the janitor's whole sweep costs
        one paginated listing instead of a head_object per tape.
        """
        out: list[dict] = []
        token: Optional[str] = None
        while True:
            kw = {"Bucket": self._bucket, "Prefix": prefix}
            if token is not None:
                kw["ContinuationToken"] = token
            resp = await self._run(self._c().list_objects_v2, **kw)
            for o in resp.get("Contents", []):
                lm = o.get("LastModified")
                out.append({
                    "key": o["Key"],
                    "size": int(o.get("Size") or 0),
                    # boto3 hands back a tz-aware datetime; normalize to epoch seconds here so the
                    # janitor's ordering never depends on a backend's datetime flavour.
                    "last_modified": lm.timestamp() if lm is not None else 0.0,
                })
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
            if not token:
                raise RuntimeError(
                    f"list_objects_v2 reported IsTruncated with no NextContinuationToken "
                    f"(prefix={prefix!r}); object listing may be incomplete"
                )
        return sorted(out, key=lambda o: o["key"])

    async def delete(self, key: str) -> None:
        await self._run(self._c().delete_object, Bucket=self._bucket, Key=key)


class SqlAlchemyRecordingRepo:
    """``RecordingRepo`` over a SQLAlchemy-async ``session_factory`` (``meetings`` /
    ``meeting_sessions``; recordings live in ``meetings.data`` JSONB)."""

    def __init__(self, session_factory):
        self._session_factory = session_factory

    async def find_session(self, session_uid):
        from sqlalchemy import select

        from ..sessions.models import MeetingSession

        async with self._session_factory() as db:
            s = (
                await db.execute(
                    select(MeetingSession).where(MeetingSession.session_uid == session_uid)
                )
            ).scalars().first()
            return {"meeting_id": s.meeting_id, "session_uid": s.session_uid} if s else None

    async def _meeting(self, db, meeting_id):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        return (
            await db.execute(select(Meeting).where(Meeting.id == meeting_id).with_for_update())
        ).scalars().first()

    async def get_recordings(self, meeting_id):
        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)
            data = m.data if isinstance(m.data, dict) else {}
            return list(data.get("recordings", []))

    async def put_recordings(self, meeting_id, recordings):
        from sqlalchemy.orm.attributes import flag_modified

        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)
            data = dict(m.data) if isinstance(m.data, dict) else {}
            data["recordings"] = list(recordings)
            m.data = data
            flag_modified(m, "data")
            await db.commit()

    async def mutate_recordings(self, meeting_id, mutator):
        """Atomic read→modify→write under ONE ``SELECT … FOR UPDATE`` row lock (G3). The lock spans the
        whole mutation (held from the read through commit), so concurrent chunk-upload / finalize calls
        serialize instead of clobbering each other (the old get+put released the lock between)."""
        from sqlalchemy.orm.attributes import flag_modified

        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)  # SELECT … FOR UPDATE
            data = dict(m.data) if isinstance(m.data, dict) else {}
            recordings = list(data.get("recordings", []))
            new_recordings, result = mutator(recordings)
            data["recordings"] = list(new_recordings)
            m.data = data
            flag_modified(m, "data")
            await db.commit()
            return result

    async def mutate_meeting_data(self, meeting_id, mutator):
        """Row-locked ``meetings.data`` mutation with the attributed ledger split out (TC-583).

        The mutator still receives the whole JSONB payload, but
        ``data['attributed_audio_manifest']['ranges']`` is a ``SqlRangeLedger`` view backed by the
        ``attributed_audio_ranges`` table: keyed probes stay O(1) inserts/updates while the row
        lock keeps the same serialization the whole-JSONB writer had. On commit the stored
        manifest holds the header only — range payloads never re-enter ``meetings.data``.
        ``mutator(data) -> (next_data, result)`` is async so ledger probes can hit the DB.
        """
        from sqlalchemy import delete
        from sqlalchemy.orm.attributes import flag_modified

        from ..sessions.models import AttributedAudioRange
        from .ledger import (
            SqlRangeLedger,
            ledger_manifest,
            stored_manifest,
        )

        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)
            if m is None:
                raise KeyError(meeting_id)
            data = dict(m.data) if isinstance(m.data, dict) else {}
            stored = data.get("attributed_audio_manifest")
            ledger = None
            if isinstance(stored, dict):
                ledger = SqlRangeLedger(db, meeting_id)
                # Migrate any pre-table inline ``ranges`` BEFORE the mutator runs so its keyed
                # probes see every durable row (a reserve retry that only exists inline must find
                # its row, not append a duplicate that uq_attributed_range_key would reject).
                await _migrate_range_ledger(
                    db, ledger,
                    [dict(r) for r in stored.get("ranges") or [] if isinstance(r, dict)],
                )
                data["attributed_audio_manifest"] = ledger_manifest(stored, ledger)
            next_data, result = await _invoke_mutator(db, data, mutator)
            next_data = dict(next_data)
            new_manifest = next_data.get("attributed_audio_manifest")
            if not isinstance(new_manifest, dict):
                # The manifest key was removed (artifact deletion) — drop the ledger rows too.
                next_data.pop("attributed_audio_manifest", None)
                await db.execute(
                    delete(AttributedAudioRange).where(
                        AttributedAudioRange.meeting_id == meeting_id
                    )
                )
            elif ledger is not None and new_manifest.get("ranges") is ledger:
                # Same manifest dict: flush staged appends / dirty vended rows, and persist the
                # header without the range list (inline rows already migrated before the mutator).
                next_data["attributed_audio_manifest"] = stored_manifest(new_manifest)
                await _flush_range_ledger(db, ledger)
            else:
                # The mutator replaced the manifest (fresh dict or a plain list of ranges, e.g.
                # ``_manifest()`` building one for a meeting with no header yet): reconcile the
                # table wholesale under the lock.
                await db.execute(
                    delete(AttributedAudioRange).where(
                        AttributedAudioRange.meeting_id == meeting_id
                    )
                )
                rows = new_manifest.get("ranges")
                for row in rows if isinstance(rows, list) else []:
                    if isinstance(row, dict):
                        db.add(
                            AttributedAudioRange(
                                meeting_id=meeting_id,
                                sequence=row.get("sequence"),
                                idempotency_key=row.get("idempotency_key"),
                                payload=dict(row),
                            )
                        )
                next_data["attributed_audio_manifest"] = stored_manifest(new_manifest)
            m.data = dict(next_data)
            flag_modified(m, "data")
            await db.commit()
            return result

    async def attributed_artifacts_for_owner(self, user_id, meeting_id):
        from sqlalchemy import text

        from .ledger import union_ranges

        # ONE statement: header + ordered range payloads read under a single READ COMMITTED
        # snapshot, so a deletion committing mid-read can never surface a closed manifest with
        # zero ranges (a state that never durably existed). asyncpg returns JSONB aggregates
        # as text — decode before handing to union_ranges.
        async with self._session_factory() as db:
            row = (await db.execute(
                text(
                    "SELECT m.data, ("
                    "  SELECT COALESCE(jsonb_agg(r.payload ORDER BY r.id), '[]'::jsonb)"
                    "  FROM attributed_audio_ranges r WHERE r.meeting_id = m.id"
                    ") FROM meetings m WHERE m.id = :mid AND m.user_id = :uid"
                ),
                {"mid": meeting_id, "uid": user_id},
            )).first()
            if row is None:
                return None
            data, payloads = row[0], row[1]
            if not isinstance(data, dict):
                return None
            if isinstance(payloads, str):
                payloads = json.loads(payloads)
            header = data.get("attributed_audio_manifest")
            manifest = None
            if isinstance(header, dict):
                manifest = dict(header)
                manifest["ranges"] = union_ranges(
                    header.get("ranges") or [], payloads or [], meeting_id=meeting_id
                )
            return {
                "manifest": manifest,
                "artifact_deletion": (
                    dict(data["artifact_deletion"])
                    if isinstance(data.get("artifact_deletion"), dict) else None
                ),
            }

    async def attributed_range_state_for_owner(self, user_id, meeting_id, sequence):
        """Owner-scoped keyed range read — one statement, one snapshot.

        ``GET /meetings/{id}/attributed-audio/ranges/{seq}`` downloads ranges one at a time;
        resolving each through the assembled manifest is O(ranges) per call (O(n²) to fetch a
        meeting's ranges — worse than the pre-table read on large meetings).

        The download must answer exactly what the union manifest answers — including the
        dropped/malformed inline rows that only the FULL union contract resolves (a crossed
        inline twin, a duplicate key, an inline loser of a same-identity merge — TC-583
        round-8). So the shape the caller needs depends on the header:

        - Header still carries inline ``ranges`` (unmigrated legacy meeting): the caller needs
          the meeting's whole table row set to recompute the union — a CASE-guarded scalar
          subquery aggregates it, evaluated ONLY when inline ranges exist (EXPLAIN shows the
          subplan "never executed" on migrated meetings — verified empirically).
        - Header-only manifest (migrated or new meetings — the common case): the
          ``(meeting_id, sequence)`` unique index probe alone is the answer.

        Returns ``{"data": <meetings.data>, "range": <payload-at-sequence-or-None>,
        "table_ranges": <ordered payloads, None when no inline ranges>}``, ``None`` for an
        unknown or unowned meeting.
        """
        from sqlalchemy import text

        async with self._session_factory() as db:
            row = (await db.execute(
                text(
                    "SELECT m.data, r.payload,"
                    " CASE WHEN m.data #>> '{attributed_audio_manifest,ranges}' IS NULL"
                    "      THEN NULL"
                    "      WHEN jsonb_typeof(m.data #> '{attributed_audio_manifest,ranges}')"
                    "           = 'array'"
                    "      THEN (SELECT COALESCE(jsonb_agg(rr.payload ORDER BY rr.id),"
                    "                            '[]'::jsonb)"
                    "            FROM attributed_audio_ranges rr"
                    "            WHERE rr.meeting_id = m.id)"
                    "      ELSE NULL END"
                    " FROM meetings m"
                    " LEFT JOIN attributed_audio_ranges r"
                    "   ON r.meeting_id = m.id AND r.sequence = :seq"
                    " WHERE m.id = :mid AND m.user_id = :uid"
                ),
                {"seq": sequence, "mid": meeting_id, "uid": user_id},
            )).first()
            if row is None or not isinstance(row[0], dict):
                return None
            payload, table_payloads = row[1], row[2]
            if isinstance(payload, str):
                payload = json.loads(payload)
            if isinstance(table_payloads, str):
                table_payloads = json.loads(table_payloads)
            return {
                "data": row[0],
                "range": payload if isinstance(payload, dict) else None,
                "table_ranges": (
                    [p for p in table_payloads if isinstance(p, dict)]
                    if isinstance(table_payloads, list) else None
                ),
            }

    async def owner_of(self, meeting_id):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            m = (await db.execute(select(Meeting).where(Meeting.id == meeting_id))).scalars().first()
            return m.user_id if m else None

    async def prepare_recording_deletion(self, user_id, recording_id):
        from sqlalchemy import select
        from sqlalchemy.orm.attributes import flag_modified

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            meetings = (await db.execute(
                select(Meeting).where(Meeting.user_id == user_id).with_for_update()
            )).scalars().all()
            for meeting in meetings:
                data = dict(meeting.data) if isinstance(meeting.data, dict) else {}
                recordings = list(data.get("recordings") or [])
                recording = next((r for r in recordings if r.get("id") == recording_id), None)
                if recording is None:
                    continue
                if meeting.status not in ("completed", "failed"):
                    return {"error": "conflict"}
                prepared = {
                    **recording, "deletion_pending": True, "meeting_id": meeting.id,
                }
                data["recordings"] = [
                    prepared if r.get("id") == recording_id else r for r in recordings
                ]
                meeting.data = data
                flag_modified(meeting, "data")
                await db.commit()
                return prepared
            return None

    async def list_meeting_recordings(self, user_id):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            rows = (
                await db.execute(select(Meeting).where(Meeting.user_id == user_id))
            ).scalars().all()
            out = []
            for m in rows:
                data = m.data if isinstance(m.data, dict) else {}
                for r in data.get("recordings", []):
                    out.append({**r, "meeting_id": m.id})
            return out


def build_production_router(*, database_url: Optional[str] = None):
    """Construct the recordings router with real MinIO/S3 + SQLAlchemy adapters from env."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from ..db import build_engine
    from .router import build_router

    database_url = database_url or os.getenv(
        "DATABASE_URL", "postgresql+asyncpg://postgres:postgres@postgres:5432/vexa"
    )
    engine = build_engine(database_url)  # #635: env-steered pool
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    storage = S3Storage(
        bucket=os.getenv("RECORDING_BUCKET", "recordings"),
        endpoint_url=os.getenv("S3_ENDPOINT"),
        access_key=os.getenv("S3_ACCESS_KEY"),
        secret_key=os.getenv("S3_SECRET_KEY"),
    )
    return build_router(SqlAlchemyRecordingRepo(session_factory), storage)
