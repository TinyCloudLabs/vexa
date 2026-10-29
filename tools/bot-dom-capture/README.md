# Local Meet join diagnostics

Diagnostic-only. This does not change selectors, admission decisions, retry policy, or the bot's display name, and does not claim to fix an intermittent join failure.

## Ordinary bot logs

`join.selector_miss` retains only static codes, counts, validated locale fields, and an observed-lobby flag:

- `step`: `name_entry`, `join_request`, `authenticated_join_request`, or `unknown`.
- `selector_set`: `guest_name`, `guest_join`, `authenticated_join`, or `unknown`.
- `selector_mask`: bit zero names entry zero in the corresponding ordered array in `core/meetings/modules/join/src/googlemeet/selectors.ts`. A set bit means that entry was attempted. A total miss tries the entire list; the five-entry guest join list is mask `31`. `unknown` uses mask `0` and never logs a caller-supplied selector.
- `selector_count`, `candidate_count`, and `timeout_ms`. Candidate count `-1` means the structural diagnostic scan was not available; it is not a claim of zero candidates. The structural scan remains diagnostic-only and never supplies a click target.
- `html_lang` and `navigator_language`, or `unknown` when unavailable/invalid.
- `lobby_reached`: whether the flow had positively observed a name-entry or lobby media control before the failed selector wait. It is not a host-visible knock or an admission receipt. A guest join-button wait follows successful name entry; an authenticated wait records whether a mic/camera control was observed.

The historical `code=selector_not_found timeout_ms=...` error prefix remains. The same bounded metadata is appended to that error. Free-form labels, selectors, page text, URLs, paths, and browser exception messages are not added to process logs.

`admission.failed` identifies the terminal admission step with `admission_denied`, `lobby_timeout`, `admission_unconfirmed`, or `admission_error`. It preserves the existing typed outcome and message. Admission polling starts only after the join CTA resolved and was clicked, so this event records `lobby_reached=true`; that still does not prove the host saw a knock. The existing `admission.rejected` event retains the more specific host-denial/error-page/captcha classification. An intermediate `admission.blocked` / `no_positive_evidence` is not a terminal verdict: it can occur during a successful join's page transition.

The captured C fixture contains only sanitized, static name-entry and `Ask to join` control subtrees from a successful staffed local run. It is a compatibility regression, not a reproduction of an earlier failure or evidence for a new language-step selector.

## Explicit local/dev capture only

There is no production bot capture flag or invocation property. This tool is outside the bot/Lite Docker COPY inputs, workspace packages, and compiled bot. Both Docker ignore files also exclude this directory. Ordinary production configuration cannot enable code absent from the image. A Docker administrator can mount arbitrary code; this is not a security boundary against that administrator. Do not mount or preload this tool for production meetings.

Preparation creates files only; it does not launch Docker, open Meet, or dispatch a bot:

```sh
node tools/bot-dom-capture/prepare.mjs \
  --local-only --output /var/tmp/vexa-local-capture-UNIQUE
```

The output directory must not exist, including as a symlink. It is created with mode `0700`; the consent marker and mount descriptor are `0600`. Default capture is failure-only. For an explicitly authorized local/dev checkpoint run, add `--checkpoints` during preparation; this also captures name entry and the existing join-click/checkpoint boundaries.

Read `docker-options.private.json` in that private directory and add its two bind mounts and Node preload to an **already-authorized local launch**:

- This tool directory → `/opt/vexa-local-dom-capture`, **read-only**.
- The newly prepared private output → `/var/local/vexa-dom-capture`, writable.
- Generic Node preload: `NODE_OPTIONS=--require=/opt/vexa-local-dom-capture/preload.cjs`.

Do not silently combine this with existing `NODE_OPTIONS`. There is no separate capture environment switch: the preload requires the private consent marker at the fixed local mount. It uses the installed bot's pinned Playwright and join host module; no image rebuild or production code import is needed. The mount/preload is local operator code injection, not a deployable bot setting. Remove it after the authorized run. Staffed real-room checks still require their owner's explicit scheduling and dispatch permission.

An authorized local launcher that must save the last page before its own bounded timeout may explicitly call the handle returned by `install()`:

```js
const capture = require('/opt/vexa-local-dom-capture/preload.cjs').install();
// At the already-authorized local attempt's deadline, before stopping its bot:
await capture.captureDeadline();
```

Use this from a separately mounted local preload/launcher instead of also auto-preloading this tool; install it once. It requests only a sanitized `operator_deadline` snapshot, not a meeting action or a failure verdict. There is no listener, production config field, or automatic deadline. The ordinary direct Node preload also exports this handle for the offline image smoke.

## Artifact and privacy limits

The only page artifacts are allowlisted, sanitized DOM and a `*.rendered.png` screenshot of **that sanitized DOM**, rendered in a throwaway page with network requests blocked. No original live-page pixels are captured or persisted, even masked. **The rendering can differ from what the bot actually saw**: original CSS, media, frames, unknown text/attributes, and most identifiers are intentionally removed. This is not a pixel-faithful screenshot or a complete record of a new UI variant.

Known static lobby labels and a small set of public control codes are retained. Input values, participant/account subtrees, arbitrary text, links, scripts, styles, templates, comments, media, URLs, and unknown attributes are removed or redacted. No raw HTML or browser exception is printed. Each capture writes a static-code status file. Output names contain only sequence numbers and fixed checkpoint codes; files are exclusively created with mode `0600`, never overwritten, and never uploaded through recording or telemetry paths. Capture errors do not replace the join verdict: queue waits are bounded at five seconds per capture, with a static `capture_timeout` status on expiry. Capture is capped at 16 checkpoints per process.

Even sanitized output stays private: keep it outside the repository and CI uploads, inspect it before any sharing, and remove it according to the local run's retention policy. The tool adds timing and a throwaway page; it cannot prove why a different, uncaptured run failed.

Offline checks:

```sh
node --test tools/bot-dom-capture/capture.test.mjs
pnpm --filter @vexa/join exec tsx src/googlemeet/join-cta.test.ts
pnpm --filter @vexa/join exec tsx src/googlemeet/admission.test.ts
pnpm --filter @vexa/bot run test:privacy
```

### Real-image smoke without Meet

`image-smoke.cjs` runs the installed browser/join helper against the sanitized fixture and a local synthetic failure page. It uses no room, token, STT service, or account and has a 15-second watchdog. Run it only with Docker networking disabled. The private directory must be fresh; change `PROOF` for another run.

```sh
PROOF=/var/tmp/vexa-capture-smoke-UNIQUE
node tools/bot-dom-capture/prepare.mjs --local-only --checkpoints --output "$PROOF"
docker run --rm --network none \
  -e BOT_WORKER_ENTRY=/opt/vexa-local-dom-capture/image-smoke.cjs \
  -e NODE_OPTIONS=--require=/opt/vexa-local-dom-capture/preload.cjs \
  --mount "type=bind,source=$PWD/tools/bot-dom-capture,target=/opt/vexa-local-dom-capture,readonly" \
  --mount "type=bind,source=$PROOF,target=/var/local/vexa-dom-capture" \
  --mount "type=bind,source=$PWD/core/meetings/modules/join/src/googlemeet/fixtures/captured-c-guest-lobby.html,target=/fixtures/captured-c-guest-lobby.html,readonly" \
  ghcr.io/tinycloudlabs/vexa/bot@sha256:efa1e11d9fafc74fdf398a29905b96262ce91002d9d3fdac1159898017d9e8b7
```

Omit `--checkpoints` during preparation to exercise failure-only defaults. The smoke also explicitly requests an operator-deadline snapshot; this is not an automatic capture enabled by the default mode. It checks exclusive `0600` artifacts, redaction canaries, rendered-only PNGs, and that an original screenshot path was never written.
