"""The attributed-audio.v1 range ledger — per-range rows behind ``manifest["ranges"]`` (TC-583).

Range rows live in the ``attributed_audio_ranges`` table (one row per range); ``meetings.data``
keeps only the manifest header. ``mutate_meeting_data`` hands its mutator a manifest whose
``ranges`` is a ``RangeLedger``: the keyed probes a hot-path mutator needs (``find`` /
``has_sequence`` / ``empty``) stay O(1) index lookups, while ``await .all()`` materializes the
ordered ledger for the read / close / delete paths that genuinely need the whole list.

Iteration, ``len()``, indexing and equality on an UNMATERIALIZED ledger raise — a hot path must
never page the full ledger in by accident, and a caller that needs the list must say so.

``assemble_attributed_manifest`` rebuilds the public manifest shape (header + ordered ranges,
unioning any pre-table inline ``ranges`` still stored in ``meetings.data``) for every reader that
keeps the attributed-audio.v1 JSON contract.
"""
from __future__ import annotations

from typing import Optional


class RangeLedger:
    """An ordered view over one meeting's attributed range rows.

    Mutators hold this object inside ``data['attributed_audio_manifest']['ranges']``; the repo
    flushes staged appends and dirty vended rows on commit. Keyed probes are O(1); list
    operations require ``await .all()`` first.
    """

    _rows: Optional[list] = None

    async def all(self) -> list:
        """Every range, ordered (append order). Materializes once; the returned dicts are tracked
        for write-back."""
        raise NotImplementedError

    async def find(self, idempotency_key) -> Optional[dict]:
        """The live row for one idempotency key, or ``None``."""
        raise NotImplementedError



    async def has_sequence(self, sequence: int) -> bool:
        raise NotImplementedError

    async def empty(self) -> bool:
        raise NotImplementedError

    def append(self, row: dict) -> None:
        """Stage a new range row (INSERTed on commit)."""
        raise NotImplementedError

    def _materialized(self) -> list:
        if self._rows is None:
            raise RuntimeError(
                "RangeLedger requires `await .all()` before list operations — "
                "hot paths must use find()/has_sequence()/empty()"
            )
        return self._rows

    def __iter__(self):
        return iter(self._materialized())

    def __len__(self) -> int:
        return len(self._materialized())

    def __getitem__(self, index):
        return self._materialized()[index]

    def __eq__(self, other):
        if isinstance(other, RangeLedger):
            other = other._materialized()
        return self._materialized() == other

    def __hash__(self):
        return id(self)


class MemoryRangeLedger(RangeLedger):
    """``RangeLedger`` over the in-memory fakes' plain list — the fake stores its ledger inline,
    so mutations to the vended dicts are already durable and nothing needs staging."""

    def __init__(self, rows: list):
        self._rows = rows

    async def all(self) -> list:
        return self._rows

    async def find(self, idempotency_key) -> Optional[dict]:
        return next(
            (r for r in self._rows if r.get("idempotency_key") == idempotency_key), None
        )

    async def has_sequence(self, sequence: int) -> bool:
        return any(r.get("sequence") == sequence for r in self._rows)

    async def empty(self) -> bool:
        return not self._rows

    def append(self, row: dict) -> None:
        self._rows.append(row)


class SqlRangeLedger(RangeLedger):
    """``RangeLedger`` over the ``attributed_audio_ranges`` table inside the caller's session.

    Rows are fetched lazily by key/sequence; a row handed to a mutator is snapshotted, and
    ``flush()`` writes back only the rows that actually changed (one UPDATE each) plus staged
    appends (one INSERT each). ``migrate()`` moves pre-table inline ``manifest["ranges"]`` rows
    into the table once, under the same row lock.
    """

    def __init__(self, db, meeting_id: int):
        self._db = db
        self._meeting_id = meeting_id
        self._rows: Optional[list] = None
        self._appends: list = []
        self._db_ids: dict[int, int] = {}      # id(payload dict) -> table row id
        self._snapshots: dict[int, dict] = {}  # id(payload dict) -> value at vend time
        self._vended: dict[int, dict] = {}     # id(payload dict) -> live dict
        self._missed_keys: set = set()
        self._missed_seqs: set = set()

    def _vend(self, row_id: int, payload) -> dict:
        row = dict(payload or {})
        self._db_ids[id(row)] = row_id
        self._snapshots[id(row)] = dict(row)
        self._vended[id(row)] = row
        return row

    async def _select_by(self, column, value):
        from sqlalchemy import select

        from ..sessions.models import AttributedAudioRange

        return (
            await self._db.execute(
                select(AttributedAudioRange)
                .where(
                    AttributedAudioRange.meeting_id == self._meeting_id,
                    column == value,
                )
                .limit(1)
            )
        ).scalars().first()

    async def find(self, idempotency_key) -> Optional[dict]:
        for row in reversed(self._appends):
            if row.get("idempotency_key") == idempotency_key:
                return row
        if self._rows is not None:
            return next(
                (r for r in self._rows if r.get("idempotency_key") == idempotency_key), None
            )
        if idempotency_key in self._missed_keys:
            return None
        from ..sessions.models import AttributedAudioRange

        record = await self._select_by(AttributedAudioRange.idempotency_key, idempotency_key)
        if record is None:
            self._missed_keys.add(idempotency_key)
            return None
        return self._vend(record.id, record.payload)

    async def has_sequence(self, sequence: int) -> bool:
        if any(r.get("sequence") == sequence for r in self._appends):
            return True
        if self._rows is not None:
            return any(r.get("sequence") == sequence for r in self._rows)
        if sequence in self._missed_seqs:
            return False
        from sqlalchemy import exists, select

        from ..sessions.models import AttributedAudioRange

        found = await self._db.scalar(
            select(
                exists().where(
                    AttributedAudioRange.meeting_id == self._meeting_id,
                    AttributedAudioRange.sequence == sequence,
                )
            )
        )
        if not found:
            self._missed_seqs.add(sequence)
        return bool(found)

    async def empty(self) -> bool:
        if self._appends:
            return False
        if self._rows is not None:
            return not self._rows
        from sqlalchemy import exists, select

        from ..sessions.models import AttributedAudioRange

        return not bool(
            await self._db.scalar(
                select(
                    exists().where(
                        AttributedAudioRange.meeting_id == self._meeting_id
                    )
                )
            )
        )

    def append(self, row: dict) -> None:
        self._appends.append(row)
        if self._rows is not None:
            self._rows.append(row)

    async def all(self) -> list:
        if self._rows is None:
            from sqlalchemy import select

            from ..sessions.models import AttributedAudioRange

            records = (
                await self._db.execute(
                    select(AttributedAudioRange)
                    .where(AttributedAudioRange.meeting_id == self._meeting_id)
                    .order_by(AttributedAudioRange.id)
                )
            ).scalars().all()
            self._rows = [self._vend(record.id, record.payload) for record in records]
            self._rows.extend(self._appends)
        return self._rows

    async def migrate(self, legacy_rows) -> None:
        """Move pre-table inline ``manifest["ranges"]`` rows into the ledger table.

        A table row with the same idempotency key or sequence is rebound (payload UPDATE) rather
        than duplicated, so mid-deployment overlap converges instead of violating the unique
        constraints. Runs under the meetings-row lock that scopes this ledger.
        """
        rows = [dict(r) for r in legacy_rows if isinstance(r, dict)]
        if not rows:
            return
        from sqlalchemy import select, update

        from ..sessions.models import AttributedAudioRange

        existing = (
            await self._db.execute(
                select(
                    AttributedAudioRange.id,
                    AttributedAudioRange.idempotency_key,
                    AttributedAudioRange.sequence,
                ).where(AttributedAudioRange.meeting_id == self._meeting_id)
            )
        ).all()
        by_key = {}
        by_seq = {}
        for row_id, key, seq in existing:
            if key is not None:
                by_key.setdefault(key, row_id)
            if seq is not None:
                by_seq.setdefault(seq, row_id)
        for row in rows:
            row_id = by_key.get(row.get("idempotency_key"))
            if row_id is None:
                row_id = by_seq.get(row.get("sequence"))
            if row_id is None:
                self._db.add(
                    AttributedAudioRange(
                        meeting_id=self._meeting_id,
                        sequence=row.get("sequence"),
                        idempotency_key=row.get("idempotency_key"),
                        payload=row,
                    )
                )
            else:
                await self._db.execute(
                    update(AttributedAudioRange)
                    .where(AttributedAudioRange.id == row_id)
                    .values(
                        payload=row,
                        sequence=row.get("sequence"),
                        idempotency_key=row.get("idempotency_key"),
                    )
                )
        await self._db.flush()

    async def flush(self) -> None:
        """Persist staged appends and dirty vended rows; clean vended rows cost no write."""
        from sqlalchemy import update

        from ..sessions.models import AttributedAudioRange

        for row in self._appends:
            self._db.add(
                AttributedAudioRange(
                    meeting_id=self._meeting_id,
                    sequence=row.get("sequence"),
                    idempotency_key=row.get("idempotency_key"),
                    payload=dict(row),
                )
            )
        for row in self._vended.values():
            row_id = self._db_ids.get(id(row))
            if row_id is None or row == self._snapshots.get(id(row)):
                continue
            await self._db.execute(
                update(AttributedAudioRange)
                .where(AttributedAudioRange.id == row_id)
                .values(
                    payload=dict(row),
                    sequence=row.get("sequence"),
                    idempotency_key=row.get("idempotency_key"),
                )
            )
        await self._db.flush()
        self._appends.clear()
        self._vended.clear()
        self._snapshots.clear()


def ledger_manifest(manifest: Optional[dict], ledger: RangeLedger) -> Optional[dict]:
    """The manifest dict a mutator sees: stored header with ``ranges`` bound to the ledger."""
    if not isinstance(manifest, dict):
        return None
    present = dict(manifest)
    present["ranges"] = ledger
    return present


async def materialize_manifest(manifest):
    """A mutator-safe manifest result: the same dict with ``ranges`` resolved to a plain list."""
    if not isinstance(manifest, dict):
        return manifest
    ranges = manifest.get("ranges")
    if isinstance(ranges, RangeLedger):
        out = dict(manifest)
        out["ranges"] = await ranges.all()
        return out
    return manifest


def stored_manifest(manifest: dict) -> dict:
    """The JSONB form of a manifest: header only — range rows never re-enter meetings.data."""
    return {key: value for key, value in manifest.items() if key != "ranges"}


async def assemble_attributed_manifest(db, meeting_id: int, data: Optional[dict]) -> Optional[dict]:
    """The public manifest shape: stored header + ordered table ranges, unioned with any
    pre-table inline ``ranges`` (legacy rows win on key/sequence collisions, matching the lazy
    migration's ordering). ``None`` when no manifest exists — a meeting without a header never
    synthesized one."""
    from sqlalchemy import select

    from ..sessions.models import AttributedAudioRange

    header = (data or {}).get("attributed_audio_manifest")
    if not isinstance(header, dict):
        return None
    records = (
        await db.execute(
            select(AttributedAudioRange.payload)
            .where(AttributedAudioRange.meeting_id == meeting_id)
            .order_by(AttributedAudioRange.id)
        )
    ).scalars().all()
    merged = [dict(r) for r in header.get("ranges") or [] if isinstance(r, dict)]
    seen_keys = {r.get("idempotency_key") for r in merged if r.get("idempotency_key") is not None}
    seen_seqs = {r.get("sequence") for r in merged if r.get("sequence") is not None}
    for payload in records:
        row = dict(payload or {})
        if (row.get("idempotency_key") is not None and row.get("idempotency_key") in seen_keys) or (
            row.get("sequence") is not None and row.get("sequence") in seen_seqs
        ):
            continue
        merged.append(row)
    manifest = dict(header)
    manifest["ranges"] = merged
    return manifest


async def run_meeting_data_mutator(data: dict, mutator, tx_guard=None):
    """Fake-side ``mutate_meeting_data`` core: ledger-view in, materialized manifest out.

    ``tx_guard`` carries the production session so the caller can prove to the tx-scope gate
    that the mutator's work runs inside its row-locked transaction. The fake has no transaction,
    so the value is intentionally unused here.
    """
    data = dict(data)
    stored = data.get("attributed_audio_manifest")
    if isinstance(stored, dict):
        rows = stored.get("ranges")
        data["attributed_audio_manifest"] = ledger_manifest(
            stored, MemoryRangeLedger(list(rows) if isinstance(rows, list) else [])
        )
    next_data, result = await mutator(data)
    next_data = dict(next_data)
    manifest = next_data.get("attributed_audio_manifest")
    if isinstance(manifest, dict) and isinstance(manifest.get("ranges"), RangeLedger):
        present = dict(manifest)
        present["ranges"] = list(manifest["ranges"])
        next_data["attributed_audio_manifest"] = present

    return next_data, result


async def ledger_find(ranges, idempotency_key) -> Optional[dict]:
    """Keyed lookup over a RangeLedger (O(1)) or a plain list (a fresh, unbound manifest)."""
    if isinstance(ranges, RangeLedger):
        return await ranges.find(idempotency_key)
    return next((r for r in (ranges or []) if r.get("idempotency_key") == idempotency_key), None)


async def ledger_has_sequence(ranges, sequence) -> bool:
    if isinstance(ranges, RangeLedger):
        return await ranges.has_sequence(sequence)
    return any(r.get("sequence") == sequence for r in (ranges or []))


async def ledger_empty(ranges) -> bool:
    if isinstance(ranges, RangeLedger):
        return await ranges.empty()
    return not ranges


async def ledger_rows(ranges) -> list:
    """The ordered range list — materializes a ledger; passes a plain list through."""
    if isinstance(ranges, RangeLedger):
        return await ranges.all()
    return list(ranges or [])
