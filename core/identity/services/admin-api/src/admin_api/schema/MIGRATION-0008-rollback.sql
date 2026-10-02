-- MIGRATION-0008 rollback (TC-583): fold attributed_audio_ranges back into the JSONB manifest.
--
-- The pre-table meeting-api image reads manifest["ranges"] straight out of meetings.data — a
-- meeting whose ranges were migrated to (or appended in) the table would serve a 200 with zero
-- ranges to it. Run this BEFORE the base image starts again, while meeting-api is stopped.
-- Idempotent: safe to run repeatedly; re-running rewrites the same union.

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
