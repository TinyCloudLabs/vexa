# recordings — chunk upload + finalize → `meeting.data` JSONB

Ported from the parent `recordings.internal_upload_recording` + `recording_finalizer` +
`recording_jsonb`. The bot streams recording chunks (authenticated by the MeetingToken it carries);
each chunk lands in object storage and is folded into the recording's JSONB payload under
`meeting.data['recordings']` — there is **NO separate recordings table**. Finalize concatenates a
recording's chunks into a master via the golden-locked `build_recording_master` codec (recording.v1)
and stamps the JSONB media-file.

## Front door
- `build_router(repo, storage)` — the mountable routes (the unified app mounts them): POST
  `/internal/recordings/upload`, GET `/recordings`, GET `/recordings/{id}/master`.
- `upload_chunk(...)` / `finalize_master(...)` — the flow core (callable directly in tests).
- `apply_chunk_to_recording` / `chunk_storage_key` / `master_storage_key` /
  `new_recording_numeric_id` — the pure JSONB record materializers (no IO/DB).
- `Storage` / `RecordingRepo` ports + `SessionNotFound`.
- `adapters.build_production_router(...)` — wire with real MinIO/S3 + SQLAlchemy.
- `fakes` — `InMemoryStorage` / `InMemoryRecordingRepo` (offline drivers).

## The JSONB shape
`meeting.data['recordings']` is a list of recording dicts (`id`, `session_uid`, `source="bot"`,
`status`, `media_files[]`). Each `media_files[]` entry tracks per-type cumulative
`file_size_bytes` / `chunk_count`, the chunk/master `storage_path`, and `is_final` / `finalized_by`
(Pack U.7 master-preserve + sticky-COMPLETED status are ported verbatim).

## P3 seams (NOT built here)
The raw byte-stream / Range download of a finalized master, and the lifecycle-driven server-side
finalize (this carve finalizes lazily on read via `GET /recordings/{id}/master`).

Tests: `../../../tests/test_recordings.py`. Codec golden: `../../../tests/test_recording_golden.py`.

Recording uploads may include bounded `metadata.speaker_timeline` (version 1, recorder start epoch,
relative-millisecond intervals with participant ID, name and attribution). Each audio chunk carries
its own metadata batch. Metadata rejection leaves the audio durable and returns
`speaker_timeline: unavailable`. `GET /recordings/{id}/speaker-timeline` uses the same caller scope
as recording reads and combines at most 8 MiB / 50,000 intervals. Metadata lives below the
recording object prefix, separately from audio chunks and optional diagnostic tapes.
The receiver stamps sequence, audio object key and final-upload state. Reads require every part
from zero through the final upload and the same complete set of retained audio chunks. Incomplete
uploads or missing audio return 422 so callers can retain speech without asserting speaker names.

TinyCloud's `tinycloud-meeting-api-image` workflow applies these recording changes to pinned Vexa
v0.12.27 (`f64a7653acdd845224f6d7de16b58c081ff7234c`), whose receiver source matches the published
`vexaai/v012-meeting-api:v012` image inspected on September 9, 2026. It runs the assembled receiver's
tests before publishing `ghcr.io/tinycloudlabs/vexa/meeting-api:tc-<fork-sha>`. Both source revisions
are recorded on the image. The bot remains built from the TinyCloud fork. Publishing an image does
not deploy it; operators must select the tested receiver, gateway and bot images together when no calls are active.
The same workflow publishes the gateway from that pinned release with the timeline forwarding route.
`core/meetings/routes.v1.json` carries the release's existing route declarations plus the new timeline
route, using the existing recording scopes. The gateway's manifest loader validates it at startup.
The workflow's gateway acceptance patch adds that route to the release's exhaustive scope matrix
and increments its exact route counts; all existing authorization and routing assertions still run.
