# @vexa/join — the isolated meeting-joining layer

_meetings/ · module (brick) · Google Meet + MS Teams + Zoom **web client** + Jitsi Meet._

**One concern:** drive a browser into a meeting and report its **admission verdict** —
nothing else. The embedder hands in a logged-in (or guest) Playwright `Page`; the brick
runs the platform's join flow and resolves once **admitted / rejected / timed-out**. It
**never** records, transcribes, talks to redis, or calls the meeting-api — those live
outside this boundary (`_host.ts` is the only seam, and it imports nothing but Node
builtins, so the package is provably standalone).

## Surface (front door — `src/index.ts`, P6)
- `joinMeeting(page, opts): Promise<{admitted, state}>` — the main entry; infers platform from the URL or takes `opts.platform`.
- `resolvePlatform(url)`, per-platform `join*/waitFor*Admission/leave*/start*RemovalMonitor`.
- `JOIN_BROWSER_ARGS` / `getJoinBrowserArgs()` — the canonical launch flags (so join↔bot flags never drift).
- `setHooks`, `startDebugView`; types `BotConfig`, `Hooks`, `JoinState`, `JoinOptions`, `JoinResult`.

## Depends on
`playwright` (the `Page`/automation) + Node builtins only. `playwright-extra` +
`puppeteer-extra-plugin-stealth` are used by the debug harness (`scripts/`); `jsdom` is
test-only (real CSS engine for the no-browser fixtures + the selector-validity gate).
Verified by `pnpm --filter @vexa/join check:isolation` (gate:isolation, P2). CommonJS by
design — see `tsconfig.json`; ESM consumers import it via Node interop.

## Consent
The brick never auto-clicks consent; the one sanctioned exception (Meet's post-admission "Join now" notice) and its
scope are written in `src/googlemeet/README.md` ("Consent policy").

## Selector conventions
Selector validity is **per execution context**, not per engine: Playwright engines
(`text=`, `:has-text()`) exist only on the locator side; anything shipped into
`page.evaluate` runs through `document.querySelector` and must be **plain CSS**. Declare
browser-context arrays in `browserContextSelectorArrays` (per-platform `selectors.ts`) so
`src/shared/selector-validity.test.ts` CSS-parses them; text-labelled buttons are
`{ text: … }` matcher fields, matched in-page against `textContent`. The one canonical
in-page leave clicker (`src/shared/leave-click.ts`, `leaveBrowserClick`) is shared across
platforms — Google Meet and MS Teams both serialize it through `page.evaluate` — so the
walker cannot drift between the injected hook and the direct leave.

## Prove it
- `pnpm --filter @vexa/join build` · `pnpm --filter @vexa/join test` (L1/L2 admission oracle — DOM fixtures, no browser)
- Live smoke (on a VM): `Dockerfile.debug` + noVNC — see `scripts/` and the `Makefile`.

## Explicit local visual debugging

VNC/noVNC are **off by default**, including on Linux/Xvfb. Escalation only emits the existing human-help callback; it never starts visual services, even when debug opt-in is set. `startDebugView()` requires `VEXA_VISUAL_DEBUG=1` on its own process before it can start them. Keep that flag absent or `0` in production.

Opt-in also requires `VEXA_VISUAL_DEBUG_PASSWORD_FILE`: a readable regular file with no group/other permission bits (for example `0600`). Supply exactly **eight non-space printable ASCII characters**, optionally followed by one newline, with no leading `#` or `__` sequence. These restrictions enforce one literal, non-empty password rather than x11vnc's special password-file directives. VNC authentication uses only eight bytes; do not assume a longer password would add protection. The password itself is never passed in command arguments or logged.

The RFB listener is restricted to `127.0.0.1` / `::1`; the noVNC/WebSocket listener and its RFB target use `127.0.0.1`. Use an authorized local development network namespace or an operator-controlled secure tunnel; publishing Docker ports does not expose a container-loopback listener. Neither debug opt-in nor the screenshot flag is set by the repository's production deployment configuration. The separate local-only sanitized DOM tool does not require either flag.

### Real-service regression (no Meet or image build)

After `pnpm --filter @vexa/join build`, run all four modes in fresh networkless containers. The test starts its own synthetic Xvfb display. It checks default-off escalation (also with opt-in set), exact flag/password validation, actual RFB password negotiation, listener addresses, and the real Lite supervisor configuration. The supervisor dependency is only a host-side test overlay, not an image change:

```sh
python3 -m pip install --target /var/tmp/vexa-supervisor-test-deps \
  --only-binary :all: --no-deps supervisor==4.2.5
for mode in escalation escalation-opt-in opt-in lite; do
  docker run --rm --network none --entrypoint node \
    --workdir /app/core/meetings/services/bot \
    -e NODE_ENV=production -e NODE_OPTIONS=--import=tsx \
    -e PYTHONPATH=/opt/supervisor-testdeps \
    --mount "type=bind,source=$PWD/core/meetings/modules/join/dist/shared/escalation.js,target=/app/core/meetings/modules/join/dist/shared/escalation.js,readonly" \
    --mount "type=bind,source=$PWD/core/meetings/modules/join/dist/shared/visual-debug.js,target=/app/core/meetings/modules/join/dist/shared/visual-debug.js,readonly" \
    --mount "type=bind,source=$PWD/core/meetings/modules/join/src/shared/visual-debug.boundary.test.ts,target=/app/core/meetings/modules/join/dist/shared/visual-debug.boundary.test.ts,readonly" \
    --mount "type=bind,source=$PWD/deploy/lite/supervisord.conf,target=/probe/supervisord.conf,readonly" \
    --mount "type=bind,source=/var/tmp/vexa-supervisor-test-deps,target=/opt/supervisor-testdeps,readonly" \
    ghcr.io/tinycloudlabs/vexa/bot@sha256:efa1e11d9fafc74fdf398a29905b96262ce91002d9d3fdac1159898017d9e8b7 \
    /app/core/meetings/modules/join/dist/shared/visual-debug.boundary.test.ts "$mode"
done
```

No meeting, account, paid service, production mount, or published port is used. These manual Linux boundary tests are separate from the ordinary fixture suite.
