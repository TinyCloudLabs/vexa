# MIGRATION-0008 — `attributed_audio_ranges` table (TC-583)

**Status:** applied automatically by `ensure_schema` (`create_all` + additive `_sync_indexes`).
No out-of-band step and no rewrite of existing rows is required — `meetings.data` payloads are
migrated lazily by the writer (see "Legacy rows" below). The table is new, so its two unique
indexes are built against an empty table: no dedup risk, no `CONCURRENTLY` runbook.

## What changes

```text
attributed_audio_ranges (
    id               serial primary key,
    meeting_id       integer not null references meetings(id),  -- indexed
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
  `sequence` are indexed probe columns mirrored out of it so reserve's duplicate-key and
  duplicate-sequence checks are O(1) index lookups.
- `reserve` is one INSERT, `upload`/`fail` are one UPDATE each — all under the same
  `meetings`-row `SELECT … FOR UPDATE` serialization the JSONB writer used.

## The read shape is unchanged

`GET /meetings/{id}/attributed-audio` and the internal session manifest still return the exact
attributed-audio.v1 JSON: the reader assembles `header + ranges` (ordered by row id, which is
append order) at query time. `storage_path` stripping, sealing, and closing semantics are
unchanged.

## Legacy rows

Manifests written before this release still carry `ranges` inline in `meetings.data`. Readers
**union** inline ranges with table rows (inline first, dedup by `idempotency_key`); the first
row-locked write migrates the inline rows into `attributed_audio_ranges` and strips them from the
JSONB. A completed-artifact deletion still removes the key and deletes every table row for the
meeting in the same transaction.

## Blast radius

- The only writers of `attributed_audio_ranges` are the meeting-api recordings adapters.
- Deleting a `meetings` row does not cascade (no `ondelete`): meeting rows are never hard-deleted
  by the product (deletion is a JSONB tombstone), so the FK is documentation-grade.
- `sequence`/`idempotency_key` are nullable only so a malformed legacy inline row can migrate
  instead of faulting its meeting's write path; validated ingress always sets both.
