# bot — the meetings ephemeral join+capture worker (Node/TS)

## Purpose

The disposable meeting-joining browser bot (P7 worker). It boots from a single `invocation.v1`
config in `VEXA_BOT_CONFIG`, joins a Google Meet / Zoom / Teams call over a humanized browser,
captures audio, transcribes it (`@vexa/transcribe-whisper`), and publishes confirmed
`transcript.v1` segments + `lifecycle.v1` status — then dies. Node/TS because the join+capture
domain lives in the browser/Playwright ecosystem; it's a modular monolith behind ports — the
orchestrator core is offline-provable, while browser/redis/http are adapters wired only at the
composition root (`src/index.ts`).

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| consumes | scheduler / meeting-api (spawner) | `invocation.v1` in `VEXA_BOT_CONFIG` env | boot config: meeting URL, platform, ids, callback/upload URLs, secrets |
| spawns-over | `@vexa/join` + `@vexa/remote-browser` | in-process port (`JoinDriver`) | join/leave/removal over a humanized browser page |
| publishes | collector [Py] | redis stream `transcription_segments` (XADD) | `transcript.v1` durable segment feed |
| publishes | gateway → dashboard | redis pub/sub `tc:meeting:{id}:mutable` | live mutable `transcript.v1` segment |
| produces | meeting-api | HTTP POST → `inv.meetingApiCallbackUrl` | `lifecycle.v1` status events (retry/backoff) |
| produces | meeting-api | HTTP POST → `inv.recordingUploadUrl` | assembled recording master (multipart) |
| consumes | gateway (commands) | redis pub/sub `bot_commands:meeting:{id}` | `acts.v1` commands (e.g. `speak` / `speak_stop`) |

### Pre-join reachability gate (#530)

Before any meeting navigation, the orchestrator makes the FIRST `joining` emit **load-bearing**
(`orchestrator.ts` → `emitJoining`): the HTTP sink's `emitReachable` reports whether the meeting-api
callback answered at all (any HTTP status = reachable; only an all-attempts network failure — the
fresh-node CNI-lag signature — is `unreachable`). Reachable ⇒ the join proceeds with **zero added
latency** (the secondary channel is never probed). Unreachable ⇒ it probes the secondary channel
(redis PING); **either channel up ⇒ proceed** (the bot can still report), **both down ⇒ refuse to
join** and terminate fast with a typed, attributed outcome instead of an opaque crashloop.

**Exit codes** (the terminal signal on k8s, where each bot is a bare Pod, `--restart=Never`):

| Code | Meaning |
|---|---|
| `0` | clean terminal (`completed`, or a user `stop` withdraw) |
| `1` | join / runtime failure (`join_failure`, `validation_error`, admission rejected/timeout) |
| `3` | **control plane unreachable** — both the meeting-api callback and redis were unreachable at boot; the bot refused to join (`failed`, `failure_stage: requested`, `infra_fault: control_plane_unreachable`). Distinguishes a **broken node** from a **broken join** in one `kubectl describe`. |

## Contracts

Browser failure is observed independently of audio silence. A Chromium page crash produces
`failed`, exit code 1, and a `reason` beginning `browser_crashed:`; an unexpected page close uses
`browser_closed:`. The failure stage names where capture stopped. These failures omit the
completion enum rather than misclassifying an active-call crash as silence or a join failure.
The normal leave path detaches the browser monitor before deliberately closing the page.

Every 30 seconds, `[bot] resources` logs container memory current/peak/limit (where available),
OOM-kill counters, and Node RSS. The terminal event retains this evidence in `bot_resources`.
`sampled_peak_memory_bytes` is a lower bound from periodic samples; `peak_memory_bytes` comes
from the kernel. Missing cgroup data stays absent. A page crash alone does not establish OOM.

The recording sink drains its queued uploads before teardown completes. The browser recorder
delivers its last data callback before the completion marker. Permanently failed uploads are
still logged; these ordering guarantees do not make an unreachable object store reliable.

Run `pnpm --filter @vexa/bot test:browser-failure` to inject a real Chromium crash and close.
This test requires Chromium and fails when it is unavailable. It does not reproduce OOM or
replace a long Google Meet validation.

**Owns:** none — the bot is a worker that implements published meetings contracts.
**Consumes:** [`invocation.v1`](../../contracts/invocation.v1) (boot config),
[`acts.v1`](../../contracts/acts.v1) (inbound commands),
[`lifecycle.v1`](../../contracts/lifecycle.v1) (status it produces),
[`transcript.v1`](../../contracts/transcript.v1) (segments it publishes). All four are TS-mirrored
in `src/contracts.ts` and validated against the sealed registry goldens (`contracts.seal.json`).

## Isolated evaluation

Unit/integration: `pnpm test` (chained `tsx` runs — no build step). Levels:
**L1** config ajv goldens · **L2** orchestrator `lifecycle.v1` state machine (fake ports) — incl. the
#530 reachability gate (both-channels-down ⇒ no join, exit 3, `control_plane_unreachable`; either-channel
up ⇒ proceed) · **L3** transport adapters (lifecycle-http `emitReachable` reachability verdict ·
transcript-redis · acts-redis), pipeline lane, recording
assembler, replay tape. **L4** (browser/capture/speak/upload legs) runs via the standalone harness in
[`eval/`](./eval): `make -C eval run MEETING=<id>` drives a live Meet with synthetic speakers and an
autonomous PASS/FAIL verdict (`make -C eval verify` for the offline oracle self-test).

## Status

- ✅ delivered — `invocation.v1` boot config (parse + ajv-validate, fail-fast)
- ✅ delivered — orchestrator `lifecycle.v1` state machine (joining → admission → active → completed/failed)
- ✅ delivered — `transcript.v1` egress (redis stream + mutable pub/sub)
- ✅ delivered — `lifecycle.v1` HTTP callback (retry/backoff, never crashes the bot)
- ✅ delivered — `acts.v1` ingress (redis subscriber; unknown acts dropped, never thrown)
- ✅ delivered — recording assembler core (webm/wav/seq, L2/L3)
- 🟡 partial — browser join + capture + recording-upload + speak (wired; L4-gated, proven on VM via `eval/`, not unit tests)

## Synthetic memory probe

After building the bot and browser modules, run:

```sh
VEXA_TEST_MEMORY_RTC=1 VEXA_TEST_MEMORY_FULL_HEADLESS=1 pnpm --filter @vexa/bot test:memory combined 900 3 /tmp/vexa-memory-new-run
```

The output directory must not already exist. Arguments are mode (`combined`, `capture`,
`recording`, `idle`), duration in seconds, number of synthetic video streams, and output path.
Three oscillator audio streams are always generated. The optional RTC leg sends tracks through
a local peer connection. Full Chromium runs invisibly; no meeting credentials are used.
Measurements include process RSS, renderer JS heap, capture frame counts, recording byte counts
and chunk order. Audio is saved as `master.webm` for independent decoding. A two-GiB browser-RSS
guard aborts the local fixture; it is not a measured production capacity limit.

This probe measures components on the host where it runs. macOS RSS can omit compressed memory;
use Linux cgroup measurements for the deployment budget. A flat synthetic trace does not prove
a real Google Meet is stable. The deployment still requires a controlled 60-minute Meet and
repeated-call validation with decoded recording completeness and retained failure evidence.
