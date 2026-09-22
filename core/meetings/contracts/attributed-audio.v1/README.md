# attributed-audio.v1

Durable, speaker-owned audio evidence for asynchronous consumers. A range is immutable only after
its checksum-valid bytes are persisted; the manifest closes only after capture has ended.

One range may differ from its sample-clock duration by at most 250 ms (plus one sample's duration)
on the callback scheduling clock. This is the v1 producer/validator contract: producers split before
adjacent callback gaps accumulate beyond that bound, and validators accept the same bounded
wall-span/sample-clock difference.
