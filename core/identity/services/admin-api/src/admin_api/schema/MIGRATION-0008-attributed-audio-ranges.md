# MIGRATION-0008 — `attributed_audio_ranges` table (TC-583)

**Status:** applied by EITHER of two convergers, whichever reaches the database first.
admin-api's `ensure_schema` (`create_all` + additive `_sync_indexes`) converges the whole SSOT on
its startup; meeting-api's own startup additionally converges just this one table from its mirror
model (`recordings/adapters.ensure_attributed_audio_schema`, run inside the app lifespan before
traffic, additive `checkfirst` semantics only). The meeting-api path exists because the services
deploy independently — a deployment can ship a meeting-api image that contains this table against
an upstream admin-api image that predates it (ptx-dev's compose runs exactly that pair), and the
attributed write path fails on a missing table, so meeting-api fails its own startup loudly
instead. No out-of-band step and no rewrite of existing rows is required — `meetings.data`
payloads are migrated lazily by the writer (see "Legacy rows" below). The table is new, so its
two unique indexes are built against an empty table: no dedup risk, no `CONCURRENTLY` runbook.

## What changes

```text
attributed_audio_ranges (
    id               serial primary key,
    meeting_id       integer not null references meetings(id),
    sequence         integer,                                   -- unique per meeting
    idempotency_key  text,                                      -- unique per meeting
    payload          jsonb not null default '{}'
)
```

Before this change, every attributed-audio reserve / upload / fail call rewrote the whole
`meetings.data['attributed_audio_manifest']` JSONB — O(ranges) bytes per call, O(n²) per meeting.
On a long Google Meet this saturated the CVM disk via WAL checkpoint storms (meeting 85: ~5k
mutations against a manifest that closed at 2 MB).

Per-range rows are first-class now:

- `meetings.data['attributed_audio_manifest']` keeps only the manifest **header**
  (`version`, `meeting_id`, `clock_origin`, `clock_origin_ms`, `state`).
- Each range's full attributed-audio.v1 dict lives in `payload`; `idempotency_key` and
  `sequence` are probe columns mirrored out of it and covered by the two unique constraints —
  reserve's duplicate-key and duplicate-sequence checks are O(1) index lookups, and
  `uq_attributed_range_key` leads with `meeting_id`, so `WHERE meeting_id = ?` needs no
  standalone index (there is deliberately no `ix_*` on `id` or `meeting_id`; databases that ran
  the first revision of this migration may retain those two orphaned indexes — they are
  duplicates of the primary key / unique-prefix and converge-additive tooling never drops them).
- `reserve` is one INSERT, `upload`/`fail` are one UPDATE each — all under the same
  `meetings`-row `SELECT … FOR UPDATE` serialization the JSONB writer used.

## The read shape is unchanged

`GET /meetings/{id}/attributed-audio` and the internal session manifest still return the exact
attributed-audio.v1 JSON: the reader assembles `header + ranges` (ordered by row id, which is
append order) at query time. `GET …/ranges/{sequence}` resolves through the
`(meeting_id, sequence)` unique index directly — assembling the whole manifest per download
would make fetching all of a meeting's ranges O(n²). `storage_path` stripping, sealing, and
closing semantics are unchanged.

## Legacy rows

Manifests written before this release still carry `ranges` inline in `meetings.data`. Readers
**union** inline ranges with table rows — inline rows keep their positions, table rows that do
not collide on `idempotency_key` **or** `sequence` append after — and the first row-locked write
migrates that exact union into `attributed_audio_ranges` and strips the inline list from the
JSONB, so a write can never reorder the externally visible manifest. A collision adopts the
more-advanced payload: an inline reservation (sealed) never overwrites a table row that already
reached uploaded/failed. Malformed inline rows that duplicate a key or sequence are dropped
(first occurrence wins, logged) rather than faulting the meeting's write path on every call.
A completed-artifact deletion removes the key and deletes every table row for the meeting in
the same transaction.

## Deploy ordering — stop-then-start only

**Do NOT roll this release over a running fleet.** Old images read `manifest["ranges"]` from
`meetings.data`; once the first new-image write migrates a meeting, its header is ranges-free —
an old image still serving that meeting sees a `closed` manifest with zero ranges (it would
answer `200` with an empty attributed-audio manifest and, worse, append new ranges into the
inline list the new image no longer reads first). Deploy as: stop all meeting-api replicas →
start new replicas → the advisory-locked DDL converges once while others queue.

## Rollback

If this image must be rolled back, the table rows have to be moved back into
`meetings.data['attributed_audio_manifest']['ranges']` BEFORE the base image runs again —
otherwise every migrated meeting reads as a 200-with-zero-ranges. Run
`MIGRATION-0008-rollback.sql` in this directory (its UPDATE is also inlined below and exercised
verbatim by `tests/test_attributed_ledger_pg.py::test_rollback_sql_restores_inline_manifest`):

```sql
-- MIGRATION-0008 rollback: fold attributed_audio_ranges back into the JSONB manifest.
-- Safe to run repeatedly (idempotent); run while meeting-api is STOPPED.
UPDATE meetings m
SET data = jsonb_set(
    m.data, '{attributed_audio_manifest,ranges}',
    COALESCE((
        SELECT jsonb_agg(r.payload ORDER BY r.id)
        FROM attributed_audio_ranges r
        WHERE r.meeting_id = m.id
    ), '[]'::jsonb)
)
WHERE m.data ? 'attributed_audio_manifest';
```

The pre-table image reads `manifest["ranges"]` straight from the JSONB — a table row appended by
a crashed/mid-deployed new image (never folded back) would be invisible to it; this script is the
fold-back. After it runs, `attributed_audio_ranges` is stale but harmless; the next forward
deploy re-migrates via the union path (a table row that advanced past its inline twin keeps its
payload — see "Legacy rows").

## Blast radius

- The only writers of `attributed_audio_ranges` are the meeting-api recordings adapters.
- Deleting a `meetings` row does not cascade (no `ondelete`): the product never hard-deletes
  meeting rows today (deletion is a JSONB tombstone) — if that ever changes, range rows must be
  cleaned in the same transaction or the FK gains a cascade.
- `sequence`/`idempotency_key` are nullable only so a malformed legacy inline row can migrate
  instead of faulting its meeting's write path; validated ingress always sets both.
