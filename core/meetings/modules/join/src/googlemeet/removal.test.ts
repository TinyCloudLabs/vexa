/**
 * Google Meet removal monitor: a stopped monitor never reports (TC-903).
 *
 * The bot stops the monitor before a deliberate leave. A tick already awaiting the page when that
 * happens must not turn the bot's own "You left the meeting" screen into a removal — neither the
 * dismiss click nor onRemoval may run after stop().
 *
 * Run: npx tsx src/googlemeet/removal.test.ts
 */
import { startGoogleRemovalMonitor } from './removal';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };

/** A page whose "You left the meeting" visibility is a deferred the test resolves; every other
 *  removal indicator reads not-visible. `evaluate` (the dismiss click) is optionally deferred too. */
function fakePage(leftScreen: Deferred<boolean>, evaluateGate?: Deferred<void>) {
  const calls = { evaluate: 0 };
  const page: any = {
    calls,
    locator: (sel: string) => ({
      first: () => ({
        isVisible: () => (sel === 'text="You left the meeting"' ? leftScreen.promise : Promise.resolve(false)),
      }),
    }),
    evaluate: async () => { calls.evaluate++; if (evaluateGate) await evaluateGate.promise; },
  };
  return page;
}

/** Run one monitor with setInterval captured: returns its tick and the stop fn. */
function startCaptured(page: any, onRemoval: () => void) {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let tick: (() => unknown) | null = null;
  (globalThis as any).setInterval = (cb: () => unknown) => { tick = cb; return 1; };
  (globalThis as any).clearInterval = () => {};
  try {
    const stop = startGoogleRemovalMonitor(page, onRemoval);
    return { tick: () => tick!(), stop };
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

(async () => {
  console.log('\n=== google removal monitor: stop() wins over an in-flight tick ===');
  {
    const left = deferred<boolean>();
    const page = fakePage(left);
    let removals = 0;
    const m = startCaptured(page, () => { removals++; });
    const running = m.tick();
    await settle();
    m.stop();                                   // the bot pauses removal before its deliberate leave
    left.resolve(true);                         // …and the in-flight tick then sees the leave screen
    await running;
    await settle();
    check('stopped during the page check → onRemoval not called', removals === 0, `removals=${removals}`);
    check('…and no dismiss click', page.calls.evaluate === 0, `evaluate=${page.calls.evaluate}`);
  }
  {
    const left = deferred<boolean>();
    const gate = deferred<void>();
    const page = fakePage(left, gate);
    let removals = 0;
    const m = startCaptured(page, () => { removals++; });
    left.resolve(true);
    const running = m.tick();
    await settle();
    m.stop();                                   // stopped while the dismiss click is in flight
    gate.resolve();
    await running;
    await settle();
    check('stopped during the dismiss click → onRemoval not called', removals === 0, `removals=${removals}`);
  }
  {
    const left = deferred<boolean>();
    const page = fakePage(left);
    let removals = 0;
    const m = startCaptured(page, () => { removals++; });
    left.resolve(true);
    await m.tick();
    await settle();
    check('control (never stopped): a real removal is reported once', removals === 1, `removals=${removals}`);
    await m.tick();
    check('…and not twice', removals === 1);
    m.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
