- **Meeting bot: a transient attributed-audio upload failure no longer ends per-speaker recording (TC-560).**
  Reserve/upload/fail/close requests to the meeting-api now retry network, timeout, 429, and 5xx
  errors with bounded backoff (idempotency keys already make the replays safe); a range that still
  cannot be uploaded is durably recorded `failed` and capture continues, so the meeting manifest
  still closes instead of rejecting every later frame.
