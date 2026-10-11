/**
 * Cooperative cancellation of a Google Meet join (TC-903).
 *
 * The bot cancels a rejoin it no longer wants (user stop, SIGTERM, time cap). The join must stop at
 * its next checkpoint and reject with the abort reason — above all, it must never send the
 * join / ask-to-join click after the abort.
 *
 * Run: npx tsx src/googlemeet/join-abort.test.ts
 */
import { joinGoogleMeeting, waitForLobbyCta } from './join';
import { googleAuthJoinCtaSelectors, googleJoinButtonSelectors, googleNameInputSelectors } from './selectors';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

/** The session.test.ts stand-in, with hooks for fill and waitForTimeout. */
function mockPage(visible: string[], hooks: { onFill?: () => void; onWait?: (ms: number) => void } = {}) {
  const clicks: string[] = [];
  const handle = (sel: string) => ({
    click: async () => { clicks.push(sel); },
    isVisible: async () => true,
  });
  const page: any = {
    clicks,
    gotos: 0,
    goto: async () => { page.gotos++; },
    bringToFront: async () => {},
    screenshot: async () => {},
    waitForTimeout: async (ms: number) => { hooks.onWait?.(ms); },
    fill: async () => { hooks.onFill?.(); },
    mouse: { move: async () => {} },
    url: () => 'https://meet.google.com/abc-defg-hij',
    evaluate: async () => ({ lang: 'en', nav: 'en-US' }),
    evaluateHandle: async () => ({
      getProperty: async (k: string) => ({
        jsonValue: async () => (k === 'labels' ? [] : null),
        asElement: () => null,
      }),
      dispose: async () => {},
    }),
    waitForSelector: (sel: string) =>
      visible.includes(sel) ? Promise.resolve(handle(sel)) : Promise.reject(new Error(`mock: ${sel} not on page`)),
    $: async (sel: string) => (visible.includes(sel) ? handle(sel) : null),
    locator: (sel: string) => ({
      first: () => ({
        isVisible: async () => visible.includes(sel),
        elementHandle: async () => (visible.includes(sel) ? handle(sel) : null),
      }),
    }),
  };
  return page;
}

const isAbort = (e: unknown) => (e as Error | undefined)?.name === 'AbortError';
const URL_ = 'https://meet.google.com/abc-defg-hij';

(async () => {
  console.log('\n=== joinGoogleMeeting honours an AbortSignal ===');
  // Anonymous flow: the abort lands while the name is being typed — the ask-to-join click must not follow.
  {
    const ac = new AbortController();
    const page = mockPage([googleNameInputSelectors[0], googleJoinButtonSelectors[0]], { onFill: () => ac.abort() });
    const err = await joinGoogleMeeting(page, URL_, 'Vexa Bot', { platform: 'google_meet', uiInteractionMode: 'synthetic', signal: ac.signal } as any)
      .then(() => null, (e: unknown) => e);
    check('anonymous: abort during name entry → rejects AbortError', isAbort(err), String(err));
    check('…and no ask-to-join click', !page.clicks.some((c: string) => googleJoinButtonSelectors.includes(c)), `clicks: ${page.clicks}`);
  }
  // Authenticated flow: the abort lands during a settle wait — no CTA click.
  {
    const ac = new AbortController();
    const page = mockPage([...googleAuthJoinCtaSelectors], { onWait: () => ac.abort() });
    const err = await joinGoogleMeeting(page, URL_, 'Vexa Bot', { platform: 'google_meet', authenticated: true, uiInteractionMode: 'synthetic', signal: ac.signal } as any)
      .then(() => null, (e: unknown) => e);
    check('authenticated: abort during a wait → rejects AbortError', isAbort(err), String(err));
    check('…and no join CTA click', page.clicks.length === 0, `clicks: ${page.clicks}`);
  }
  // Already aborted: no navigation at all.
  {
    const page = mockPage([]);
    const err = await joinGoogleMeeting(page, URL_, 'Vexa Bot', { platform: 'google_meet', uiInteractionMode: 'synthetic', signal: AbortSignal.abort() } as any)
      .then(() => null, (e: unknown) => e);
    check('pre-aborted: rejects AbortError before navigating', isAbort(err) && page.gotos === 0, `${String(err)} gotos=${page.gotos}`);
  }

  console.log('\n=== waitForLobbyCta stops polling on abort ===');
  {
    const ac = new AbortController();
    let polls = 0;
    const page = mockPage([], { onWait: () => { polls++; ac.abort(); } });
    const started = Date.now();
    const err = await waitForLobbyCta(page, googleJoinButtonSelectors, 60_000, 'join button', ac.signal).then(() => null, (e: unknown) => e);
    check('abort after the first poll → rejects AbortError', isAbort(err), String(err));
    check('…well before the selector timeout', Date.now() - started < 5_000 && polls === 1, `polls=${polls}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
