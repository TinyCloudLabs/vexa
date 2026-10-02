"""The attributed-audio.v1 range ledger — per-range rows behind ``manifest["ranges"]`` (TC-583).

Range rows live in the ``attributed_audio_ranges`` table (one row per range); ``meetings.data``
keeps only the manifest header. ``mutate_meeting_data`` hands its mutator a manifest whose
``ranges`` is a ``RangeLedger``: the keyed probes a hot-path mutator needs (``find`` /
``has_sequence`` / ``empty``) stay O(1) index lookups, while ``await .all()`` materializes the
ordered ledger for the read / close / delete paths that genuinely need the whole list.

Iteration, ``len()``, indexing and equality on an UNMATERIALIZED ledger raise — a hot path must
never page the full ledger in by accident, and a caller that needs the list must say so.

``union_ranges`` is THE dedup/ordering contract shared by reads, migration and rollback: given
the inline ``manifest["ranges"]`` still stored in ``meetings.data`` and the meeting's table
rows, it returns one collision-free ordered list — inline rows keep their positions,
non-colliding table rows append after, and a collision keeps the strictly more-advanced payload
(equal rank prefers the durable table row over its inline twin). Readers union; migration
writes the union back to the table — so a write that migrates cannot reorder or regress the
externally visible manifest.

``assemble_attributed_manifest`` applies ``union_ranges`` to rebuild the public manifest shape
for every reader that keeps the attributed-audio.v1 JSON contract.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger("meeting_api.recordings.ledger")


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

# A range's lifecycle rank — used only to resolve collisions so a stale reservation can never
# regress a more-advanced row. ``uploaded`` outranks ``failed``: a delivered object's
# storage_path must never be replaced by a failed retry's payload (Opus L4). Unknown/absent
# states rank lowest (they lose).
_RANGE_STATE_RANK = {"uploaded": 3, "failed": 2}


def _supersedes(new: dict, new_from_table: bool, old: dict, old_from_table: bool) -> bool:
    """``new`` may take ``old``'s slot only when strictly more advanced — or, at equal rank,
    when ``new`` is the durable TABLE row displacing an inline twin (the durable copy is
    preferred at equal rank; a table payload is only ever superseded by a strictly
    more-advanced row, so a stored upload's evidence can never silently regress)."""
    rn = _RANGE_STATE_RANK.get(new.get("state"), 0)
    ro = _RANGE_STATE_RANK.get(old.get("state"), 0)
    if rn > ro:
        return True
    if rn < ro:
        return False
    return new_from_table and not old_from_table


def union_ranges(inline_rows, table_rows, *, meeting_id: Optional[int] = None,
                 dropped_out: Optional[list] = None) -> list:
    """The union of a header's inline ``ranges`` and the meeting's table rows, in THE canonical
    order every reader, the lazy migration and the offline rollback share:

    1. Inline rows, in stored order, deduplicated first-wins on idempotency_key OR sequence
       (a malformed legacy row carrying a duplicate can otherwise never migrate — its INSERT
       would violate the unique constraints on every write, permanently 500-ing the meeting;
       Opus L3).
    2. Each table row, in table order: a row whose key or sequence collides with one or more
       live slots merges ALL of them — the surviving payload occupies the earliest colliding
       slot, and the survivor is chosen by ``_supersedes`` (strict rank win; equal rank prefers
       the table copy over an inline twin, and the earlier slot between two table payloads).
       A non-colliding row appends.

    The identity maps are maintained exactly: every slot the merge consumes is unregistered
    before the survivor's identity is installed, so a later row can never merge into a dropped
    slot or silently skip a table row (the Astra/Opus round-4 defects). The result is unique
    in BOTH dimensions even when a key collision and a sequence collision cross — inline
    (a,1),(b,2) vs table (a,2): the table payload merges at the earliest slot and the
    conflicting inline sibling drops.

    Every non-surviving row — malformed, duplicate, displaced or superseded, inline or table —
    is appended to ``dropped_out`` when provided (reporting is the caller's job: migrate warns
    once, rollback counts, readers stay silent). Every returned element is a fresh dict —
    callers may mutate freely.
    """
    out: list = []
    origins: list = []          # parallel to ``out``: True = payload came from the table
    by_key: dict = {}
    by_seq: dict = {}
    dropped: list = dropped_out if dropped_out is not None else []

    def _unregister(p: int) -> None:
        """Remove every identity mapping of slot ``p`` — a slot that changes identity or is
        dropped must leave no stale key/sequence pointing at it."""
        row = out[p]
        k, s = row.get("idempotency_key"), row.get("sequence")
        if k is not None and by_key.get(k) == p:
            del by_key[k]
        if s is not None and by_seq.get(s) == p:
            del by_seq[s]

    for row in inline_rows or []:
        if not isinstance(row, dict):
            dropped.append(row)
            continue
        key, seq = row.get("idempotency_key"), row.get("sequence")
        if (key is not None and key in by_key) or (seq is not None and seq in by_seq):
            dropped.append(dict(row))
            continue
        pos = len(out)
        out.append(dict(row))
        origins.append(False)
        if key is not None:
            by_key[key] = pos
        if seq is not None:
            by_seq[seq] = pos
    for row in table_rows or []:
        if not isinstance(row, dict):
            dropped.append(row)
            continue
        row = dict(row)
        key, seq = row.get("idempotency_key"), row.get("sequence")
        positions = []
        if key is not None and key in by_key:
            positions.append(by_key[key])
        if seq is not None and seq in by_seq and by_seq[seq] not in positions:
            positions.append(by_seq[seq])
        if not positions:
            pos = len(out)
            out.append(row)
            origins.append(True)
            if key is not None:
                by_key[key] = pos
            if seq is not None:
                by_seq[seq] = pos
            continue
        # Merge every colliding slot: fold candidates left-to-right — the table row under
        # merge counts LAST (wins equal rank against inline twins but never supersedes a
        # table payload of equal rank), and between two colliding slot payloads the earlier
        # position wins the tie.
        positions.sort()
        target = positions[0]
        merged, merged_from_table = row, True
        for p in positions:
            if _supersedes(out[p], origins[p], merged, merged_from_table):
                merged, merged_from_table = out[p], origins[p]
        # Unregister + report every displaced payload BEFORE the survivor is installed — the
        # survivor's own registrations point at ``target`` and every other slot is dead.
        for p in positions:
            if out[p] is not merged:
                dropped.append(out[p])
            _unregister(p)
            if p != target:
                out[p] = None
                origins[p] = False
        if merged is not row:
            dropped.append(row)
        out[target] = merged
        origins[target] = merged_from_table
        mk, ms = merged.get("idempotency_key"), merged.get("sequence")
        if mk is not None:
            by_key[mk] = target
        if ms is not None:
            by_seq[ms] = target
    return [r for r in out if r is not None]


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

        The table is rewritten to EXACTLY ``union_ranges`` order — inline rows keep their
        positions, non-colliding table rows follow — so a mutator whose first write migrates
        never reorders the externally visible manifest (a read is the same union). Collisions
        resolve via ``union_ranges``: the more-advanced payload survives, so a stale inline
        reservation cannot regress a table row that already reached uploaded/failed, and a
        malformed duplicate or crossed-identity inline row is dropped (never an IntegrityError
        that 500s the meeting's write path on every call). Runs under the meetings-row lock
        that scopes this ledger.
        """
        rows = [dict(r) for r in legacy_rows if isinstance(r, dict)]
        if not rows:
            return
        from sqlalchemy import delete, select

        from ..sessions.models import AttributedAudioRange

        existing = (
            await self._db.execute(
                select(AttributedAudioRange.payload)
                .where(AttributedAudioRange.meeting_id == self._meeting_id)
                .order_by(AttributedAudioRange.id)
            )
        ).scalars().all()
        dropped: list = []
        merged = union_ranges(rows, existing, meeting_id=self._meeting_id,
                              dropped_out=dropped)
        if dropped:
            log.warning(
                "attributed-audio migration dropped %d duplicate/displaced range row(s) "
                "for meeting %s", len(dropped), self._meeting_id,
            )

        # Wholesale rewrite in union order under the row lock — the row ids are internal, and
        # migration runs at most once per meeting (the header's inline list is stripped on the
        # same write), so the O(n) delete+insert is a one-time cost.
        await self._db.execute(
            delete(AttributedAudioRange).where(
                AttributedAudioRange.meeting_id == self._meeting_id
            )
        )
        for row in merged:
            self._db.add(
                AttributedAudioRange(
                    meeting_id=self._meeting_id,
                    sequence=row.get("sequence"),
                    idempotency_key=row.get("idempotency_key"),
                    payload=row,
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
    """The public manifest shape: stored header + the ``union_ranges`` merge of any pre-table
    inline ``ranges`` with the meeting's table rows (inline position kept; collisions carry the
    more-advanced payload — the same list a migration writes back). ``None`` when no manifest
    exists — a meeting without a header never synthesized one."""
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
    manifest = dict(header)
    manifest["ranges"] = union_ranges(
        header.get("ranges") or [], records, meeting_id=meeting_id
    )
    return manifest


async def run_meeting_data_mutator(data: dict, mutator):
    """Fake-side ``mutate_meeting_data`` core: ledger-view in, materialized manifest out.

    The production adapter binds ``ranges`` to a ``SqlRangeLedger`` before calling the mutator
    and writes the table back itself; this runner does the same in-memory so the fakes and the
    tests share the exact ledger contract.
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
