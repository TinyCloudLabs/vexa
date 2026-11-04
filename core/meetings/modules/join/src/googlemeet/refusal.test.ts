/**
 * The re-knock loop for Meet refusing a knock ("You can't join this video call", refusal.ts).
 * Ported from upstream Vexa-ai/vexa#1921 for TC-2443, plus the fork's abort and structured-log cases.
 *
 * Meet's refusal is flaky (upstream join harness, 29 Oct 2026: every refused bot got through on its
 * second or third knock), so a refused knock is retried up to GOOGLE_JOIN_MAX_KNOCKS within the same
 * lobby budget. Anything else ends the loop untouched.
 *
 * Run: npx tsx src/googlemeet/refusal.test.ts
 */
import {
  knockUntilGoogleAccepts, GoogleJoinRefusedError, GOOGLE_JOIN_MAX_KNOCKS, GOOGLE_JOIN_REFUSED,
  watchGoogleJoinRefusal, throwIfGoogleJoinRefused,
} from './refusal';
import { AdmissionError } from '../shared/admission';
import { waitForAnySelector, waitForLobbyCta } from './join';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` (${detail})` : ''}`); failed++; }
}

const page: any = {};
const refused = () => new GoogleJoinRefusedError('CreateMeetingDevice answered HTTP 403', 1, 'CreateMeetingDevice');

/** Run `fn` while capturing the structured events it logs. */
async function captureEvents<T>(fn: () => Promise<T>): Promise<{ result: T | unknown; events: any[] }> {
  const events: any[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string') {
      try {
        const record = JSON.parse(args[0]);
        if (record?.event) { events.push(record); return; }
      } catch { /* not a structured line */ }
    }
    original(...args);
  };
  try {
    const result = await fn().catch((e) => e);
    return { result, events };
  } finally {
    console.log = original;
  }
}

(async () => {
  console.log('\n=== knockUntilGoogleAccepts ===');

  // Refused, refused, then the host's lobby admits: three knocks, admitted.
  {
    let knocks = 0;
    const got = await knockUntilGoogleAccepts(page, 60_000, async () => {
      knocks++;
      if (knocks < 3) throw refused();
      return true;
    });
    check('refused twice, then admitted → admitted on knock 3', got === true && knocks === 3, `got=${got} knocks=${knocks}`);
  }

  // Refused every time: stops at the bound and says how many knocks Meet refused.
  {
    let knocks = 0;
    const err = await knockUntilGoogleAccepts(page, 60_000, async () => { knocks++; throw refused(); }).catch((e) => e);
    check(`refused every knock → stops after ${GOOGLE_JOIN_MAX_KNOCKS}`, knocks === GOOGLE_JOIN_MAX_KNOCKS, `knocks=${knocks}`);
    check('… typed denial', err instanceof GoogleJoinRefusedError && err.outcome === 'denial', String(err));
    check('… message names the refusal and the knock count',
      err?.message?.startsWith(`${GOOGLE_JOIN_REFUSED}: Google Meet refused the join on ${GOOGLE_JOIN_MAX_KNOCKS} of ${GOOGLE_JOIN_MAX_KNOCKS} knocks`) &&
      /never received a request/.test(err.message), err?.message);
    check('… keeps the refusing call', err?.call === 'CreateMeetingDevice', String(err?.call));
  }

  // A host denial, a lobby timeout, a crash or a cancelled join is not re-knocked.
  const abort = new AbortController();
  abort.abort(new Error('join cancelled by the orchestrator'));
  for (const [label, e] of [
    ['host denial', new AdmissionError('denial', 'Bot admission was rejected by meeting admin')],
    ['lobby timeout', new AdmissionError('lobby_timeout', 'still in the waiting room')],
    ['crash', new Error('Target page, context or browser has been closed')],
    ['cancelled join', abort.signal.reason],
  ] as const) {
    let knocks = 0;
    const err = await knockUntilGoogleAccepts(page, 60_000, async () => { knocks++; throw e; }).catch((x) => x);
    check(`${label} → one knock, error passed through unchanged`, knocks === 1 && err === e, `knocks=${knocks}`);
  }

  // Re-knocks share the issued lobby budget; an exhausted budget ends the loop.
  {
    let clock = 0;
    const budgets: number[] = [];
    const err = await knockUntilGoogleAccepts(page, 30_000, async (remaining) => {
      budgets.push(remaining);
      clock += 20_000;
      throw refused();
    }, () => clock).catch((x) => x);
    check('re-knock gets the remaining budget, not a fresh one', budgets[0] === 30_000 && budgets[1] === 10_000, JSON.stringify(budgets));
    check('… and the loop stops when the budget is spent', budgets.length === 2 && err instanceof GoogleJoinRefusedError, `knocks=${budgets.length}`);
  }

  // Admitted on the first knock: no re-knock.
  {
    let knocks = 0;
    const got = await knockUntilGoogleAccepts(page, 60_000, async () => { knocks++; return true; });
    check('admitted on knock 1 → one knock', got === true && knocks === 1, `knocks=${knocks}`);
  }

  // Every refused knock leaves one structured event that the bot's log sanitizer keeps (no free text).
  {
    let knocks = 0;
    const { result, events } = await captureEvents(() => knockUntilGoogleAccepts(page, 60_000, async () => {
      knocks++;
      if (knocks === 1) throw refused();
      if (knocks === 2) throw new GoogleJoinRefusedError('Meet showed "You can\'t join this video call"');
      return true;
    }));
    const refusedEvents = events.filter((e) => e.event === 'join.refused');
    check('two refused knocks → two join.refused events, then admitted', result === true && refusedEvents.length === 2, JSON.stringify(events));
    check('… each names the knock, the bound and the refusing call by static code',
      refusedEvents[0]?.attempt === 1 && refusedEvents[0]?.attempts_max === GOOGLE_JOIN_MAX_KNOCKS &&
      refusedEvents[0]?.refused_call === 'create_meeting_device' && refusedEvents[0]?.error_code === 'join_refused' &&
      refusedEvents[1]?.attempt === 2 && refusedEvents[1]?.refused_call === 'refusal_screen',
      JSON.stringify(refusedEvents));
  }

  console.log('\n=== the network signal ===');

  // throwIfGoogleJoinRefused carries the call the response listener saw.
  {
    const listeners: ((r: any) => void)[] = [];
    const blank: any = {
      on: (ev: string, fn: (r: any) => void) => { if (ev === 'response') listeners.push(fn); },
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    };
    watchGoogleJoinRefusal(blank);
    watchGoogleJoinRefusal(blank); // idempotent per page
    check('the listener attaches once per page', listeners.length === 1, `listeners=${listeners.length}`);
    for (const fn of listeners) fn({ status: () => 403, url: () => 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/ResolveMeetingSpace' });
    const err = await throwIfGoogleJoinRefused(blank, 'lobby, name input').catch((e) => e);
    check('ResolveMeetingSpace 403 → typed refusal carrying the call', err instanceof GoogleJoinRefusedError && err.call === 'ResolveMeetingSpace', `${err?.name} ${err?.call}`);
  }

  console.log('\n=== the lobby waits ===');

  // The lobby waits stop on a refusal instead of running out their 120 s / 60 s budget (the pre-click
  // refusal: ResolveMeetingSpace 403 while the bot still waits for the name field, TC-2443).
  {
    const blank: any = {
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      waitForTimeout: async () => {},
      screenshot: async () => {},
    };
    let polls = 0;
    const guard = async () => { if (++polls >= 3) throw refused(); };
    const t = Date.now();
    const nameErr = await waitForAnySelector(blank, ['input[type="text"]'], 120_000, 'name input', undefined, false, guard).catch((e) => e);
    check('name-input wait ends on the refusal guard, typed', nameErr instanceof GoogleJoinRefusedError && polls === 3 && Date.now() - t < 5_000, `${nameErr?.name} polls=${polls}`);
    polls = 0;
    const ctaErr = await waitForLobbyCta(blank, ['button:has-text("Ask to join")'], 60_000, 'join button', undefined, true, guard).catch((e) => e);
    check('join-button wait ends on the refusal guard, typed', ctaErr instanceof GoogleJoinRefusedError && polls === 3, `${ctaErr?.name} polls=${polls}`);
  }

  // A cancelled join still wins over the guard: the abort is checked first on every poll.
  {
    const blank: any = {
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      waitForTimeout: async () => {},
      screenshot: async () => {},
    };
    const cancelled = new AbortController();
    cancelled.abort(new Error('join cancelled by the orchestrator'));
    let guarded = 0;
    const err = await waitForAnySelector(blank, ['input[type="text"]'], 120_000, 'name input', cancelled.signal, false, async () => { guarded++; throw refused(); }).catch((e) => e);
    check('aborted join → the abort, not a refusal', err === cancelled.signal.reason && guarded === 0, `${err?.name} guarded=${guarded}`);
  }

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
