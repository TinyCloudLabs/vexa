- **Fix attributed-audio write amplification in long Google Meets (TinyCloudLabs/vexa#583).** Each
  attributed-audio range now writes its own `attributed_audio_ranges` row — reserve, upload and fail
  are constant-cost — instead of rewriting the whole manifest JSONB on the meeting row, which grew
  quadratically and saturated the Postgres disk in long meetings. The manifest API response shape is
  unchanged, and manifests written before this release migrate to rows lazily on first write.
