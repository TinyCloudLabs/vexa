# attributed-audio.v1

Durable, speaker-owned audio evidence for asynchronous consumers. A range is immutable only after
its checksum-valid bytes are persisted; the manifest closes only after capture has ended.

Adjacent callbacks are one range when their scheduling gap is at most 250 ms. This tolerance is
part of the v1 producer/validator contract: a larger gap starts a new range, and the validator
accepts the resulting wall-span/sample-clock difference up to the same bound.
