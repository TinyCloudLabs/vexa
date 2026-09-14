# bot/scripts

[`check-isolation.js`](check-isolation.js) — the service's `gate:isolation` (P2) check: every
`src/` import must be intra-package, a Node builtin, or a declared dep (the composed bricks
`@vexa/{join, remote-browser, recording, record-chunker, gmeet-pipeline, mixed-pipeline,
transcribe-whisper}` + `ajv` / `ajv-formats` + devDeps) — never another brick's internals,
never another domain.

The orchestrator core (`config.ts · ports.ts · orchestrator.ts · contracts.ts`) imports only
its own files + node builtins + ajv; the `@vexa/*` front doors are touched solely at the
composition root (`index.ts`). Run by the gate as `node scripts/check-isolation.js`.

[`memory-probe.ts`](memory-probe.ts) runs the real capture/recording bridge over synthetic
audio and optional loopback WebRTC video, collecting process RSS, renderer JS heap and
recording-order evidence. See the service README for invocation and measurement limits.
`VEXA_TEST_MEMORY_NATIVE=1` adds Chromium's sampled native allocations and bounded memory
traces once per minute. These diagnostic runs have profiling overhead and should be compared
separately from acceptance runs without profiling. The probe also reports cgroup counters when
available and counts fallback `captureStream()` track creation/stops without retaining tracks.

On macOS, build [`memory-footprint.c`](memory-footprint.c) with `cc -O2 memory-footprint.c
-o /tmp/vexa-memory-footprint` and set `VEXA_TEST_MEMORY_FOOTPRINT_BINARY=/tmp/vexa-memory-footprint`.
It reads `proc_pid_rusage` kernel counters, including compressed memory and lifetime peak,
without suspending the browser. Avoid `vmmap` during audio acceptance: inspecting a live process
can pause it and create the very recording gaps being measured. Native allocation traces are
also a separate profiling run; acceptance uses the kernel counters and normal frame/part counts.

Set `VEXA_TEST_MEET_URL` only for an explicitly authorized, dedicated Google Meet room.
The probe then uses the existing join module and measures real incoming capture/recording
with local sinks; it does not start the full deployed transcription pipeline. The duration
starts after admission. Speak or provide test media during the run. Output directories are
private (0700); audio, screenshots and logs may contain meeting content and must not be
published as ordinary CI artifacts. Keep the room URL outside source control. Synthetic
three-tone completeness checks do not apply to live speech. A denied guest requires host
authorization or an invited, authenticated test account before another attempt.

The TinyCloud image workflow's optional `validate_candidate` input runs a 15-minute
synthetic probe and the real Chromium crash/close boundary test inside the built Linux
image. It passes no real Meet URL or production credentials. Its 3 GiB Docker limit is
a runner-protection guard, not a production budget. Synthetic audio/log artifacts are
retained for seven days; real-room output must not be uploaded through this workflow.
Crash/close checks run first as a separate step; `crash_test_only` skips the long probe
when diagnosing that boundary. Both checks stream their generated-fixture logs to the
Actions log while retaining artifact copies. A failed check still fails the workflow.
On Linux, the crash fixture sends SIGKILL only after identifying exactly one renderer
descended from its own Node process. It simulates the incident’s OS process kill, not
memory pressure or a kernel OOM decision. On desktop hosts it uses Chromium’s
`chrome://crash` trigger, as in Playwright’s `tests/library/page-event-crash.spec.ts`.
Both paths require an actual page crash event and the correct retained reason.
