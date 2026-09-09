# record-chunker/src

Front door [`index.ts`](index.ts) — the recorder entry point: `MediaRecorderChunker` (the
MediaRecorder loop over a ready `stream`) + `createRecordingTap` (find + combine the page's audio
elements, then drive the chunker). Emits `recording.v1` chunks (`{ base64, chunkSeq, isFinal, mimeType }`)
via an injected `onChunk`; one final `isFinal=true` chunk on stop. No master assembly.

Zero external imports — pure browser. The loop is unit-pinned by
[`chunker.smoke.test.ts`](chunker.smoke.test.ts); the live path is validated in a real meeting.

`createSpeakerTimeline` collects recording-clock participant intervals without retaining audio.
It expires stale evidence, distinguishes overlap from unknown, and caps pending metadata at
256 entries; overflow is explicit unknown coverage until the next chunk drain.
