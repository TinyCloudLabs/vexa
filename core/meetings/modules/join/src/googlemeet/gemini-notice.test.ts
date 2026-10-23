/**
 * TC-1606 — Meet bot never enters the call when Gemini notes / transcription / recording is on.
 *
 * OBSERVED (live, anonymous-guest bot, QA host): ~4 s after the host admits the bot, Meet shows the
 * GUEST a modal dialog — "This video call is being transcribed. Gemini is taking notes." (Gemini notes /
 * transcription) or "This video call is being recorded" (recording only) — with exactly [Leave] [Join now].
 * The guest is not in the call (host People never lists it) until "Join now" is pressed. Both copies are
 * verbatim captures: fixtures/gemini-notice.captured.html and fixtures/recording-notice.captured.html.
 *
 * Before the fix: the Gemini copy matched the pre-admission consent selector
 * (`[role="dialog"]:has-text("taking notes")`) so admission was suppressed forever, in a wait loop (the late
 * waiting-room loop) with no escalation and no log; the recording copy matched NO consent selector, so the
 * bot reported ADMITTED (status active) while it sat outside the call.
 *
 * WHAT THIS FILE PINS
 *   1. Both captured copies: the bot presses "Join now" (once, never "Leave"), emits the sanitizer-surviving
 *      `join.gemini_notice_handled` event, and the wait resolves ADMITTED once the dialog is gone — including
 *      in the production loop shape that stalled silently.
 *   2. While the notice is up the guest is NOT admitted (neither copy), and the notice is not misread as
 *      pre-admission consent.
 *   3. The click is scoped to exactly this shape: any dialog without "Join now", with other buttons, with the
 *      pre-admission `take notes for me` consent text, or with unrelated text is NEVER clicked, and the
 *      pre-admission consent hold is intact.
 *   4. If the click does nothing the bot gives up after 3 attempts and escalates (needs_human_help
 *      `modal_dialog`) instead of clicking forever.
 *
 * Fixture honesty: the dialog subtrees are captured; the call chrome around them (tile, toolbar) is a minimal
 * stand-in consistent with the captured page text. jsdom supplies the real CSS engine; the Page adapter below
 * implements only the Playwright surface the detectors use (`text=`, `:has-text()`, evaluate, evaluateHandle).
 *
 * No browser, no live meeting, no Google.
 *
 * Run: npx tsx src/googlemeet/gemini-notice.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';
import { findGeminiNoticeContinueButton } from './gemini-notice';
import * as selectors from './selectors';
import * as admission from './admission';
import { AdmissionError } from '../shared/admission';
import { resetEscalation } from '../shared/escalation';
import { setHooks } from '../_host';

const { hasConsentPrompt, checkForGoogleAdmissionIndicators, waitForGoogleMeetingAdmission, detectGeminiNotice, handleGeminiNotice } = admission;

const NOTICE_HTML = readFileSync(join(__dirname, 'fixtures', 'gemini-notice.captured.html'), 'utf8');
const RECORDING_HTML = readFileSync(join(__dirname, 'fixtures', 'recording-notice.captured.html'), 'utf8');

// ── call-chrome stand-ins (names scrubbed; consistent with the captured page text) ──────────────────
const REAL_TILE = '<div data-participant-id="p1" aria-label="[host]"><span>[host]</span></div>';
const TOOLBAR = '<div><button aria-label="Leave call">call_end</button><button aria-label="Chat with everyone">chat</button></div>';
const LOBBY = '<div><span>Please wait until a meeting host brings you into the call</span></div>';
const callWith = (extra: string) => `${REAL_TILE}${TOOLBAR}${extra}`;

// ── jsdom-backed Page: only the Playwright surface the detectors touch ─────────────────────────────
type Dom = { dom: JSDOM; doc: Document; clicks: string[]; dismissOnJoin: boolean };
function mount(html: string, dismissOnJoin = true): Dom {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  // jsdom has no layout: give every element a box; visibility keys on computed style.
  dom.window.Element.prototype.getBoundingClientRect = () =>
    ({ width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { dom, doc: dom.window.document, clicks: [], dismissOnJoin };
}

/** Every document/open-shadow-root under the page, so fixtures can live in either. */
function allRoots(d: Dom): ParentNode[] {
  const roots: ParentNode[] = [d.doc];
  for (let i = 0; i < roots.length; i++) {
    for (const el of Array.from(roots[i].querySelectorAll('*'))) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  return roots;
}

/** Record every click on a dialog button; "Join now" also dismisses the dialog, as Meet does. */
function wireDialogButtons(d: Dom): void {
  for (const root of allRoots(d)) {
    for (const button of Array.from(root.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button'))) {
      button.addEventListener('click', () => {
        const label = (button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        d.clicks.push(label);
        if (label === 'join now' && d.dismissOnJoin) {
          // Climb to the top-level element under <body>, crossing shadow boundaries via the host.
          let top: Element = button;
          for (;;) {
            const parent: Element | null = top.parentElement ?? ((top.getRootNode() as ShadowRoot).host ?? null);
            if (!parent || parent === d.doc.body) break;
            top = parent;
          }
          top.remove();
        }
      });
    }
  }
}

function isShown(win: Window, el: Element): boolean {
  const cs = win.getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

/** Resolve one Playwright selector (the shapes in selectors.ts) to elements. */
function resolve(d: Dom, sel: string): Element[] {
  const all = (css: string) => Array.from(d.doc.querySelectorAll(css));
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const textOf = (el: Element) => norm(el.textContent || '');
  let m: RegExpMatchArray | null;
  if ((m = sel.match(/^text="(.*)"$/s))) {
    const want = norm(m[1].replace(/\\'/g, "'"));
    return all('body *').filter((el) => el.children.length === 0 && textOf(el) === want);
  }
  if ((m = sel.match(/^text=(.*)$/s))) {
    const want = norm(m[1].replace(/\\'/g, "'"));
    return all('body *').filter((el) => el.children.length === 0 && textOf(el).includes(want));
  }
  if ((m = sel.match(/^(.*):has-text\("(.*)"\)$/s))) {
    const want = norm(m[2]);
    return all(m[1]).filter((el) => textOf(el).includes(want));
  }
  try { return all(sel); } catch { return []; }
}

function domPage(d: Dom, onWait?: (ms: number) => void): any {
  const win = d.dom.window as unknown as Window;
  const loc = (sel: string) => {
    const els = () => resolve(d, sel);
    return {
      first: () => ({ isVisible: async () => { const e = els()[0]; return !!e && isShown(win, e); }, getAttribute: async () => null }),
      count: async () => els().length,
      evaluateAll: async (fn: (e: Element[]) => unknown) => fn(els()),
    };
  };
  // Run an in-page function against this document, the way page.evaluate / evaluateHandle would.
  const inPage = async <T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<Awaited<T>> => {
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, getComputedStyle: g.getComputedStyle };
    g.window = win; g.document = d.doc; g.getComputedStyle = win.getComputedStyle.bind(win);
    try { return await fn(arg); } finally { Object.assign(g, saved); }
  };
  return {
    locator: loc,
    evaluate: inPage,
    evaluateHandle: async (fn: (arg?: unknown) => Element | null, arg?: unknown) => {
      const el = await inPage(fn, arg);
      const handle = {
        click: async () => { el?.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); },
        dispose: async () => {},
      };
      return { asElement: () => (el ? handle : null), dispose: async () => {} };
    },
    mouse: { move: async () => {} },
    screenshot: async () => {},
    waitForTimeout: async (ms: number) => { onWait?.(ms); },
    frames: () => [{ url: () => 'https://meet.google.com/' }],
    url: () => 'https://meet.google.com/[code]',
  };
}

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failed++; }
}

/** Run `fn` while capturing every line the bot's JSON logger prints. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    try { lines.push(JSON.parse(String(a[0]))); } catch { /* not a JSON line */ }
  };
  try { return { result: await fn(), lines }; } finally { console.log = orig; }
}

// Synthetic input: no X display exists here (humanized input is the production default).
const BOT = { platform: 'google_meet', botName: 'x', uiInteractionMode: 'synthetic' as const };

/**
 * Run the shipped admission wait against `d` on a deterministic clock (the loop's deadline and 2 s poll interval
 * run on Date.now(), which advances only when the loop waits — no real sleeping). `onWait(n)` mutates the page
 * on the n-th wait. Returns the verdict plus everything the bot emitted.
 */
async function runWait(d: Dom, onWait?: (n: number) => void, budgetMs = 60_000, tweak?: (page: any) => void) {
  resetEscalation();
  const helpReasons: string[] = [];
  setHooks({ onState: (st, detail) => { if (st === 'needs_human_help') helpReasons.push(String(detail?.reason)); } });
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  let waits = 0;
  const page = domPage(d, (ms) => { clock += ms; waits++; onWait?.(waits); });
  tweak?.(page);
  try {
    const { result, lines } = await captureLogs(async () => {
      try { return await waitForGoogleMeetingAdmission(page, budgetMs, BOT); }
      catch (e) { return e instanceof AdmissionError ? `AdmissionError:${e.outcome}` : `Error:${(e as Error).message}`; }
    });
    const handled = lines.filter((l) => l.event === 'join.gemini_notice_handled');
    const unknownDialogEvents = lines.filter((l) => l.event === 'join.unknown_blocking_dialog').length;
    return { result, handled, helpReasons, unknownDialogEvents };
  } finally {
    Date.now = realNow;
    resetEscalation();
  }
}

(async () => {
  delete process.env.DISPLAY; // escalation must not try to start a VNC stack here
  const withDialog = (html: string, dismissOnJoin = true, mutate?: (d: Dom) => void) => { const d = mount(callWith(html), dismissOnJoin); mutate?.(d); wireDialogButtons(d); return d; };
  const copies: [string, string][] = [['Gemini notes / transcription', NOTICE_HTML], ['recording only', RECORDING_HTML]];

  for (const [name, html] of copies) {
    console.log(`\n=== captured notice (${name}): the bot presses "Join now" and is admitted ===`);
    check('detected as the notice', (await detectGeminiNotice(domPage(withDialog(html)))).present, true);
    check('not misread as pre-admission consent', await hasConsentPrompt(domPage(withDialog(html))), false);
    check('real tile + call chrome + notice → NOT admitted before the click (guest has not joined)',
      await checkForGoogleAdmissionIndicators(domPage(withDialog(html))), false);

    // Admission wait in the shape that stalled in production: first poll sees no lobby text, then the lobby
    // appears (→ the late waiting-room loop, which has no escalation), then the host admits and the notice
    // replaces the lobby.
    const d = mount('<div></div>');
    const run = await runWait(d, (n) => {
      if (n === 1) d.doc.body.innerHTML = LOBBY;
      if (n === 4) { d.doc.body.innerHTML = callWith(html); wireDialogButtons(d); }
    });
    check('wait resolves ADMITTED (active) after the click', run.result, true);
    check('pressed "Join now" exactly once and never "Leave"', d.clicks.join(','), 'join now');
    check('emits one join.gemini_notice_handled event with success=true attempt=1',
      JSON.stringify(run.handled.map((e) => [e.success, e.attempt])), JSON.stringify([[true, 1]]));
    check('no needs_human_help escalation on the happy path', run.helpReasons.length, 0);
  }

  console.log('\n=== the in-page function is self-contained (it is serialized into the browser) ===');
  {
    // page.evaluate ships fn.toString() into the page, where module scope and esbuild's `__name` helper (tsx
    // wraps nested functions in it) do not exist. Live run F1 (first attempt): the detector threw
    // "__name is not defined" inside the page, every call returned "no notice", and the bot never clicked.
    const dom = new JSDOM(`<!doctype html><body>${callWith(NOTICE_HTML)}</body>`, { runScripts: 'outside-only' });
    dom.window.Element.prototype.getBoundingClientRect = () =>
      ({ width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const args = {
      mode: 'click',
      dialogSelectors: selectors.googleGeminiNoticeDialogSelectors,
      blockingDialogSelectors: selectors.googleGeminiNoticeBlockingDialogSelectors,
      modalSelectors: selectors.googleGeminiNoticeModalSelectors,
      blockingTexts: selectors.googleGeminiNoticeBlockingTexts,
      controlSelectors: selectors.googleGeminiNoticeControlSelectors,
      buttonSelectors: selectors.googleGeminiNoticeButtonSelectors,
      sentences: selectors.googleGeminiNoticeSentences,
      captureSentenceCount: selectors.googleGeminiNoticeCaptureSentenceCount,
      leaveLabel: selectors.googleGeminiNoticeLeaveLabel,
      continueLabel: selectors.googleGeminiNoticeContinueLabel,
    };
    let found: unknown = 'threw';
    try { found = dom.window.eval(`(${findGeminiNoticeContinueButton.toString()})(${JSON.stringify(args)})`); } catch { /* stays 'threw' */ }
    check('shipped function source, evaluated in a clean window, finds the "Join now" button',
      found && typeof found === 'object' && 'textContent' in found ? String((found as Element).textContent).trim() : found, 'Join now');
  }

  console.log('\n=== once the notice is gone the call reads as admitted ===');
  check('same call without the notice → admitted', await checkForGoogleAdmissionIndicators(domPage(mount(callWith('')))), true);
  check('detectGeminiNotice is false on a plain in-call page', (await detectGeminiNotice(domPage(mount(callWith(''))))).present, false);
  check('detectGeminiNotice is false in the lobby', (await detectGeminiNotice(domPage(mount(LOBBY)))).present, false);

  console.log('\n=== NEGATIVE: dialogs that are not exactly the notice are never clicked ===');
  const negatives: [string, string][] = [
    ['pre-admission "take notes for me" consent', '<div role="dialog"><h2>Turn on take notes for me?</h2><button>Turn on</button><button>No thanks</button></div>'],
    ['"taking notes" dialog without "Join now"', '<div role="dialog"><h2>Gemini is taking notes.</h2><button>Learn more</button></div>'],
    ['notice text with only "Leave"', '<div role="dialog"><h2>This video call is being recorded</h2><button>Leave</button></div>'],
    ['notice text, [Leave] [Join now] plus a third button', '<div role="dialog"><h2>This video call is being recorded</h2><button>Leave</button><button>Join now</button><button>Learn more</button></div>'],
    ['notice text with other buttons [Leave] [Continue]', '<div role="dialog"><h2>This video call is being recorded</h2><button>Leave</button><button>Continue</button></div>'],
    ['notice text with [Decline] [Join now]', '<div role="dialog"><h2>This video call is being recorded</h2><button>Decline</button><button>Join now</button></div>'],
    ['[Leave] [Join now] but unrelated text', '<div role="dialog"><h2>Ready to join?</h2><button>Leave</button><button>Join now</button></div>'],
    ['[Leave] [Join now] outside any dialog role', '<div><h2>This video call is being recorded</h2><button>Leave</button><button>Join now</button></div>'],
    ['role=alertdialog with the notice text and [Leave] [Join now]', '<div role="alertdialog"><h2>This video call is being recorded</h2><button>Leave</button><button>Join now</button></div>'],
    ['notice with an extra share control (checkbox "Share transcript")', '<div role="dialog"><h2>This video call is being recorded</h2><label><input type="checkbox"> Share transcript</label><button>Leave</button><button>Join now</button></div>'],
    ['notice with an extra role=checkbox control', '<div role="dialog"><h2>This video call is being transcribed. Gemini is taking notes.</h2><div role="checkbox" aria-checked="false">Allow Gemini to share notes</div><button>Leave</button><button>Join now</button></div>'],
    ['notice with a link (e.g. "Learn more") plus [Leave] [Join now]', '<div role="dialog"><h2>This video call is being recorded</h2><a href="#x">Learn more</a><button>Leave</button><button>Join now</button></div>'],
    ['notice with a text input plus [Leave] [Join now]', '<div role="dialog"><h2>This video call is being recorded</h2><input type="text"><button>Leave</button><button>Join now</button></div>'],
    ['pre-admission consent that also says "taking notes" with [Leave] [Join now]', '<div role="dialog"><h2>Gemini is taking notes. Take notes for me?</h2><button>Leave</button><button>Join now</button></div>'],
    ['"taking notes" alone ([Leave] [Join now], no recording/transcription sentence)', '<div role="dialog"><h2>Gemini is taking notes.</h2><button>Leave</button><button>Join now</button></div>'],
    ['notice text plus extra prose (a data-sharing sentence)', '<div role="dialog"><h2>This video call is being recorded</h2><p>Your name and email will be shared with the organizer.</p><button>Leave</button><button>Join now</button></div>'],
    ['"Leave" and "Join now" are anchors, not buttons', '<div role="dialog" aria-modal="true"><h2>This video call is being recorded</h2><a href="/leave">Leave</a><a href="/share">Join now</a></div>'],
    ['"Join now" is a role=link, "Leave" a button', '<div role="dialog"><h2>This video call is being recorded</h2><button>Leave</button><span role="link" tabindex="0">Join now</span></div>'],
    ['"Join now" is a plain focusable div (tabindex=0), not a button', '<div role="dialog"><h2>This video call is being recorded</h2><button>Leave</button><div tabindex="0">Join now</div></div>'],
    ['"Join now" is an input[type=button]', '<div role="dialog"><h2>This video call is being recorded</h2><button>Leave</button><input type="button" value="Join now"></div>'],
    ['third focusable div (aria-label "Share transcript", tabindex=0)', '<div role="dialog"><h2>This video call is being recorded</h2><div tabindex="0" aria-label="Share transcript"></div><button>Leave</button><button>Join now</button></div>'],
    ['third element: contenteditable region', '<div role="dialog"><h2>This video call is being recorded</h2><div contenteditable="true"></div><button>Leave</button><button>Join now</button></div>'],
    ['third element: role=switch', '<div role="dialog"><h2>This video call is being recorded</h2><div role="switch" aria-checked="false"></div><button>Leave</button><button>Join now</button></div>'],
    ['third element: role=combobox', '<div role="dialog"><h2>This video call is being recorded</h2><div role="combobox"></div><button>Leave</button><button>Join now</button></div>'],
    ['third element: select', '<div role="dialog"><h2>This video call is being recorded</h2><select><option>Share with everyone</option></select><button>Leave</button><button>Join now</button></div>'],
    ['third element: <details>/<summary>', '<div role="dialog"><h2>This video call is being recorded</h2><details><summary>More</summary></details><button>Leave</button><button>Join now</button></div>'],
    ['share-data style dialog', '<div role="dialog"><h2>Allow Gemini to share meeting content?</h2><button>Leave</button><button>Allow</button></div>'],
  ];
  for (const [name, html] of negatives) {
    const d = withDialog(html);
    check(`${name} → not the notice`, (await detectGeminiNotice(domPage(d))).present, false);
    check(`${name} → handleGeminiNotice clicks nothing`, await handleGeminiNotice(domPage(d), BOT), 'absent');
    check(`${name} → zero clicks`, d.clicks.length, 0);
  }

  console.log('\n=== accessible-tree check: names, shadow roots, unknown content, hidden/nested dialogs ===');
  const REC = 'This video call is being recorded';
  const shadowShare = (d: Dom, mode: 'open' | 'closed', inner: string) => {
    const host = d.doc.getElementById('host') as Element;
    const root = host.attachShadow({ mode });
    root.innerHTML = inner;
  };
  const treeNegatives: [string, string, ((d: Dom) => void) | undefined][] = [
    ['Join now button whose aria-label says "Share meeting data"', `<div role="dialog"><h2>${REC}</h2><button>Leave</button><button aria-label="Share meeting data">Join now</button></div>`, undefined],
    ['Join now button whose aria-labelledby names another element', `<div role="dialog"><h2 id="t">${REC}</h2><button>Leave</button><button aria-labelledby="t">Join now</button></div>`, undefined],
    ['Leave button whose aria-label says something else', `<div role="dialog"><h2>${REC}</h2><button aria-label="Allow sharing">Leave</button><button>Join now</button></div>`, undefined],
    ['Join now button whose aria-label is "Join now now" (name != visible text)', `<div role="dialog"><h2>${REC}</h2><button>Leave</button><button aria-label="Join now now">Join now</button></div>`, undefined],
    ['third "Share" button inside an OPEN shadow root', `<div role="dialog"><h2>${REC}</h2><div id="host"></div><button>Leave</button><button>Join now</button></div>`, (d) => shadowShare(d, 'open', '<button>Share</button>')],
    ['third focusable div inside an OPEN shadow root', `<div role="dialog"><h2>${REC}</h2><div id="host"></div><button>Leave</button><button>Join now</button></div>`, (d) => shadowShare(d, 'open', '<div tabindex="0">Share</div>')],
    ['prose inside an open shadow root', `<div role="dialog"><h2>${REC}</h2><div id="host"></div><button>Leave</button><button>Join now</button></div>`, (d) => shadowShare(d, 'open', '<p>Your email will be shared.</p>')],
    ['CLOSED shadow host (custom element) inside the dialog', `<div role="dialog"><h2>${REC}</h2><x-share id="host"></x-share><button>Leave</button><button>Join now</button></div>`, (d) => shadowShare(d, 'closed', '<button>Share</button>')],
    ['custom element without a shadow root inside the dialog', `<div role="dialog"><h2>${REC}</h2><x-share></x-share><button>Leave</button><button>Join now</button></div>`, undefined],
    ['iframe inside the dialog', `<div role="dialog"><h2>${REC}</h2><iframe></iframe><button>Leave</button><button>Join now</button></div>`, undefined],
    ['dialog is aria-hidden="true"', `<div role="dialog" aria-hidden="true"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div>`, undefined],
    ['dialog sits under an aria-hidden ancestor', `<div aria-hidden="true"><div role="dialog"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div></div>`, undefined],
    ['dialog sits under an inert ancestor', `<div inert><div role="dialog"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div></div>`, undefined],
    ['matching dialog nested inside a "Take notes for me?" consent dialog', `<div role="dialog"><h2>Take notes for me?</h2><div role="dialog"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div></div>`, undefined],
    ['matching dialog nested inside an alertdialog', `<div role="alertdialog"><h2>Heads up</h2><div role="dialog"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div></div>`, undefined],
  ];
  for (const [name, html, mutate] of treeNegatives) {
    const d = withDialog(html, true, mutate);
    check(`${name} → not the notice`, (await detectGeminiNotice(domPage(d))).present, false);
    check(`${name} → handleGeminiNotice clicks nothing`, await handleGeminiNotice(domPage(d), BOT), 'absent');
    check(`${name} → zero clicks`, d.clicks.length, 0);
  }
  {
    // Positive controls for the name algorithm: a matching aria-label / aria-labelledby is still the notice.
    const ok1 = `<div role="dialog"><h2>${REC}</h2><button aria-label="Leave">Leave</button><button aria-label="Join now">Join now</button></div>`;
    const ok2 = `<div role="dialog"><h2>${REC}</h2><button>Leave</button><button aria-labelledby="jn"><span id="jn">Join now</span></button></div>`;
    check('matching aria-label on both buttons → still the notice', (await detectGeminiNotice(domPage(withDialog(ok1)))).present, true);
    check('aria-labelledby resolving to "Join now" → still the notice', (await detectGeminiNotice(domPage(withDialog(ok2)))).present, true);
    // The real captured notice inside an open-shadow-root-free page is unaffected by an unrelated open shadow root
    // OUTSIDE the dialog (the walk is scoped to the dialog's own tree).
    const outside = mount(callWith(`<div id="host"></div>${NOTICE_HTML}`)); wireDialogButtons(outside);
    shadowShare(outside, 'open', '<button>Share</button>');
    check('open shadow root outside the dialog does not disqualify the real notice', (await detectGeminiNotice(domPage(outside))).present, true);
  }

  console.log('\n=== a notice hosted in an open shadow root: found, clicked, and never reported admitted before dismissal ===');
  {
    const inShadow = (html: string) => {
      const d = mount(callWith('<div id="host"></div>'));
      (d.doc.getElementById('host') as Element).attachShadow({ mode: 'open' }).innerHTML = html;
      wireDialogButtons(d);
      return d;
    };
    check('shadow-hosted recording notice → detected', (await detectGeminiNotice(domPage(inShadow(RECORDING_HTML)))).present, true);
    check('shadow-hosted recording notice + real tile → NOT admitted before dismissal',
      await checkForGoogleAdmissionIndicators(domPage(inShadow(RECORDING_HTML))), false);
    const d = inShadow(RECORDING_HTML);
    check('shadow-hosted recording notice → handleGeminiNotice presses Join now', await handleGeminiNotice(domPage(d), BOT), 'clicked');
    check('shadow-hosted recording notice → pressed once, never Leave', d.clicks.join(','), 'join now');
    check('shadow-hosted recording notice → admitted AFTER dismissal', await checkForGoogleAdmissionIndicators(domPage(d)), true);
    const w = inShadow(RECORDING_HTML);
    const run = await runWait(w);
    check('shadow-hosted recording notice → wait resolves admitted only after the click', run.result === true && w.clicks.join(',') === 'join now', true);
    const g = inShadow(NOTICE_HTML);
    check('shadow-hosted Gemini notice + real tile → NOT admitted before dismissal',
      await checkForGoogleAdmissionIndicators(domPage(g)), false);
  }

  console.log('\n=== blocking guard: a capture notice that is NOT the clickable one still blocks admission and escalates ===');
  const blockers: [string, (() => Dom)][] = [
    ['notice + extra checkbox (light DOM)', () => withDialog(`<div role="dialog"><h2>${REC}</h2><label><input type="checkbox"> Share transcript</label><button>Leave</button><button>Join now</button></div>`)],
    ['notice as role=alertdialog', () => withDialog(`<div role="alertdialog"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div>`)],
    ['notice as <dialog open>', () => withDialog(`<dialog open><h2>${REC}</h2><button>Leave</button><button>Join now</button></dialog>`)],
    ['shadow-hosted notice with an extra Share button', () => {
      const d = mount(callWith('<div id="host"></div>'));
      (d.doc.getElementById('host') as Element).attachShadow({ mode: 'open' }).innerHTML = `<div role="dialog"><h2>${REC}</h2><button>Share</button><button>Leave</button><button>Join now</button></div>`;
      wireDialogButtons(d);
      return d;
    }],
    ['"Gemini is taking notes" dialog with other buttons', () => withDialog('<div role="dialog"><h2>Gemini is taking notes.</h2><button>Stop</button></div>')],
  ];
  for (const [name, build] of blockers) {
    check(`${name} → NOT admitted`, await checkForGoogleAdmissionIndicators(domPage(build())), false);
    const d = build();
    const run = await runWait(d, undefined, 1_000);
    check(`${name} → wait never resolves admitted`, run.result === true, false);
    check(`${name} → no click beyond the approved notice`, d.clicks.filter((c) => c !== 'join now').length, 0);
  }
  {
    const d = withDialog(`<div role="alertdialog"><h2>${REC}</h2><button>Leave</button><button>Join now</button></div>`);
    const run = await runWait(d, undefined, 1_000);
    check('alertdialog notice → zero clicks and escalated modal_dialog', d.clicks.length === 0 && run.helpReasons.join(',') === 'modal_dialog', true);
  }
  {
    const pill = `<div role="status">Gemini is taking notes</div>`;
    check('persistent in-call "Gemini is taking notes" pill (not a dialog) + real tile → still admitted',
      await checkForGoogleAdmissionIndicators(domPage(mount(callWith(pill)))), true);
    const toast = mount(callWith('<div id="host"></div>'));
    (toast.doc.getElementById('host') as Element).attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog"><h2>Microphone not found</h2><button>Close</button></div>';
    check('unrelated shadow-hosted dialog + real tile → still admitted', await checkForGoogleAdmissionIndicators(domPage(toast)), true);
  }

  console.log('\n=== fail-safe: ANY unknown modal blocks admission, is never clicked, and escalates (review round 5) ===');
  // The real tile is rendered behind each of these (the false-admitted shape). None of them is the exact known
  // English notice, so none may be clicked; each must keep admission false and summon a human.
  const modalCases: [string, string, ((d: Dom) => void) | undefined][] = [
    ['reworded notice ("This video call is recorded", aria-modal)', '<div role="dialog" aria-modal="true"><h2>This video call is recorded</h2><button>Leave</button><button>Join now</button></div>', undefined],
    ['reworded notice ("This meeting is being recorded")', '<div role="dialog" aria-modal="true"><h2>This meeting is being recorded</h2><button>Leave</button><button>Join now</button></div>', undefined],
    ['non-English notice (Finnish)', '<div role="dialog" aria-modal="true"><h2>Tämä videopuhelu tallennetaan</h2><button>Poistu</button><button>Liity nyt</button></div>', undefined],
    ['non-English notice (German)', '<div role="dialog" aria-modal="true"><h2>Dieser Videoanruf wird aufgezeichnet</h2><button>Verlassen</button><button>Jetzt teilnehmen</button></div>', undefined],
    ['unknown modal with an OK button', '<div role="dialog" aria-modal="true"><h2>Something unexpected</h2><button>OK</button></div>', undefined],
    ['unknown alertdialog modal', '<div role="alertdialog" aria-modal="true"><h2>Something unexpected</h2><button>OK</button></div>', undefined],
    ['open <dialog> with unknown copy', '<dialog open><h2>Something unexpected</h2><button>OK</button></dialog>', undefined],
    ['shadow-hosted unknown modal', '<div id="host"></div>', (d) => { (d.doc.getElementById('host') as Element).attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true"><h2>Something unexpected</h2><button>OK</button></div>'; }],
    // Chromium retargets the document-level centre hit-test to the open-shadow HOST; only ShadowRoot.elementFromPoint
    // reaches the dialog. The stubs below reproduce exactly that retargeting.
    ['shadow-hosted, centred, NO aria-modal, reworded copy (hit-test retargeted to the host)', '<div id="host"></div>', (d) => {
      const host = d.doc.getElementById('host') as Element;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<div role="dialog"><h2>This video call is recorded</h2><button>Leave</button><button>Join now</button></div>';
      const inner = root.querySelector('h2') as Element;
      (d.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => host;
      (root as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => inner;
    }],
    ['two nested open shadow roots, centred, NO aria-modal (hit-test descends both)', '<div id="host"></div>', (d) => {
      const outer = d.doc.getElementById('host') as Element;
      const outerRoot = outer.attachShadow({ mode: 'open' });
      outerRoot.innerHTML = '<div id="mid"></div>';
      const mid = outerRoot.getElementById('mid') as Element;
      const midRoot = mid.attachShadow({ mode: 'open' });
      midRoot.innerHTML = '<div role="dialog"><h2>Something unexpected</h2><button>OK</button></div>';
      const inner = midRoot.querySelector('h2') as Element;
      (d.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => outer;
      (outerRoot as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => mid;
      (midRoot as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => inner;
    }],
    ['role=dialog WITHOUT aria-modal that covers the middle of the viewport', '<div role="dialog" id="cover"><h2>Something unexpected</h2><button>OK</button></div>', (d) => {
      const cover = d.doc.getElementById('cover') as Element;
      (d.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => cover.querySelector('h2') as Element;
    }],
  ];
  for (const [name, html, mutate] of modalCases) {
    const mk = () => { const d = mount(callWith(html)); mutate?.(d); wireDialogButtons(d); return d; };
    check(`${name} → NOT admitted`, await checkForGoogleAdmissionIndicators(domPage(mk())), false);
    const d = mk();
    const run = await runWait(d);
    check(`${name} → wait never resolves admitted`, run.result === true, false);
    check(`${name} → never clicked`, d.clicks.length, 0);
    check(`${name} → escalated once as modal_dialog`, run.helpReasons.join(','), 'modal_dialog');
    check(`${name} → emits join.unknown_blocking_dialog event once`, run.unknownDialogEvents, 1);
  }
  console.log('\n  -- non-modal toasts and pills must NOT block (controls) --');
  {
    const toast = '<div role="dialog"><h2>Microphone not found</h2><button>Close</button></div>';
    const tc = mount(callWith(toast));
    check('non-modal role=dialog toast (not covering the middle) + real tile → still admitted',
      await checkForGoogleAdmissionIndicators(domPage(tc)), true);
    check('closed <dialog> (not open) + real tile → still admitted',
      await checkForGoogleAdmissionIndicators(domPage(mount(callWith('<dialog><h2>Hidden</h2><button>OK</button></dialog>')))), true);
    check('Gemini pill (role=status) + real tile → still admitted',
      await checkForGoogleAdmissionIndicators(domPage(mount(callWith('<div role="status">Gemini is taking notes</div>')))), true);
    const run = await runWait(mount(callWith(toast)));
    {
      // Control: a shadow-hosted toast away from the centre must not block (hit-test lands on the call UI).
      const d = mount(callWith('<div id="host"></div>'));
      const host = d.doc.getElementById('host') as Element;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<div role="dialog"><h2>Microphone not found</h2><button>Close</button></div>';
      const tile = d.doc.querySelector('[data-participant-id]') as Element;
      (d.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => tile;
      check('shadow-hosted non-modal toast away from the centre + real tile → still admitted', await checkForGoogleAdmissionIndicators(domPage(d)), true);
    }
    check('non-modal toast → wait resolves admitted, no escalation', run.result === true && run.helpReasons.length === 0, true);
  }
  {
    // The exact known notice is modal too, but it is the one we click, and it disappears: admitted afterwards.
    const d = withDialog(RECORDING_HTML);
    const run = await runWait(d);
    check('known recording notice (aria-modal) → clicked once, then admitted, no unknown_blocking_dialog',
      run.result === true && d.clicks.join(',') === 'join now' && run.helpReasons.length === 0 && run.unknownDialogEvents === 0, true);
  }

  console.log('\n=== positive control: a non-focusable (tabindex=-1) wrapper does not disqualify the real notice ===');
  {
    const html = '<div role="dialog" aria-modal="true" tabindex="-1"><div tabindex="-1"><h2>This video call is being recorded</h2></div><button>Leave</button><button role="button">Join now</button></div>';
    check('tabindex=-1 wrapper + <button> Leave / Join now → still the notice',
      (await detectGeminiNotice(domPage(withDialog(html)))).present, true);
  }

  console.log('\n=== the deliberate pre-admission consent hold is intact ===');
  const consentText = negatives[0][1];
  check('"take notes for me" dialog → still consent', await hasConsentPrompt(domPage(withDialog(consentText))), true);
  check('"take notes for me" dialog → still not admitted',
    await checkForGoogleAdmissionIndicators(domPage(withDialog(consentText))), false);
  check('"taking notes" dialog WITHOUT "Join now" → still consent (not the notice)',
    await hasConsentPrompt(domPage(withDialog(negatives[1][1]))), true);
  {
    const d = withDialog(consentText);
    const run = await runWait(d);
    check('wait never admits and never clicks while the consent prompt is up', run.result === true || d.clicks.length > 0, false);
  }

  console.log('\n=== a click that does nothing: 3 attempts, then escalate (no endless clicking) ===');
  {
    const d = withDialog(NOTICE_HTML, false);
    const run = await runWait(d);
    check('never reports admitted', run.result === true, false);
    check('pressed "Join now" exactly 3 times', d.clicks.join(','), 'join now,join now,join now');
    check('3 handled events, attempts 1..3', JSON.stringify(run.handled.map((e) => e.attempt)), JSON.stringify([1, 2, 3]));
    check('escalates to needs_human_help with reason modal_dialog, once', run.helpReasons.join(','), 'modal_dialog');
  }

  console.log('\n=== the notice is only clicked once the bot is in the call ===');
  {
    // Lobby text still on screen, dialog present: not post-admission evidence → no click.
    const lobbyAndNotice = mount(callWith(`${LOBBY}${RECORDING_HTML}`)); wireDialogButtons(lobbyAndNotice);
    const run1 = await runWait(lobbyAndNotice);
    check('lobby text visible + notice dialog → never clicked', lobbyAndNotice.clicks.length, 0);
    check('lobby text visible + notice dialog → not admitted', run1.result === true, false);
    // No participant tile / self tile rendered: no evidence of being in the call → no click.
    const noTile = mount(`${TOOLBAR}${RECORDING_HTML}`); wireDialogButtons(noTile);
    const run2 = await runWait(noTile);
    check('notice dialog but no tile rendered (no evidence of admission) → never clicked', noTile.clicks.length, 0);
    check('notice dialog but no tile rendered → not admitted', run2.result === true, false);
  }

  console.log('\n=== every exit of the late waiting-room loop escalates (review P2) ===');
  // Production shape: first poll sees no lobby text, then the lobby appears (→ the late loop), then the lobby
  // goes away behind a dialog the detector does not recognise.
  const lateLobby = (page: string) => {
    const d = mount('<div></div>');
    const drive = (n: number) => {
      if (n === 1) d.doc.body.innerHTML = LOBBY;
      if (n === 4) { d.doc.body.innerHTML = page; wireDialogButtons(d); }
    };
    return { d, drive };
  };
  {
    const { d, drive } = lateLobby(callWith(negatives[1][1])); // "taking notes" consent-like dialog, no Join now
    const run = await runWait(d, drive);
    check('late lobby, then an unmatched "taking notes" consent dialog → never clicked', d.clicks.length, 0);
    check('late lobby, then unmatched consent dialog → fails by timeout, not admitted', run.result === 'AdmissionError:join_failure' || run.result === 'AdmissionError:lobby_timeout', true);
    check('late lobby, then unmatched consent dialog → needs_human_help with reason consent_text', run.helpReasons.join(','), 'consent_text');
  }
  {
    const { d, drive } = lateLobby(`${TOOLBAR}<div role="dialog"><h2>Something unexpected</h2><button>OK</button></div>`); // no tile: nothing says admitted
    const run = await runWait(d, drive);
    check('late lobby, then an unknown blocking dialog → escalates with a reason (not silent)',
      run.helpReasons.length === 1 && run.helpReasons[0].length > 0, true);
    check('late lobby, then an unknown blocking dialog → reason is unknown_blocking_state', run.helpReasons.join(','), 'unknown_blocking_state');
  }

  console.log('\n=== short budgets: every unresolved exit escalates, whatever the loop timing (review round 2 P2) ===');
  // Valid budgets shorter than the escalation thresholds (>80% of budget at a 2 s poll boundary, >10 s unknown).
  // The lobby appears after the first poll, then is replaced by a page that never resolves.
  for (const budget of [1_000, 2_500, 3_999, 4_000]) {
    const blockers: [string, string, string][] = [
      ['unknown dialog', `${TOOLBAR}<div role="dialog"><h2>Something unexpected</h2><button>OK</button></div>`, 'unknown_blocking_state'],
      ['unmatched "taking notes" consent dialog', callWith(negatives[1][1]), 'consent_text'],
    ];
    for (const [name, page, expected] of blockers) {
      // First poll sees no lobby; the lobby shows up after the first 2 s wait; the blocker replaces it after
      // the second wait (the reviewer's deterministic probe shape).
      const d = mount('<div></div>');
      const run = await runWait(d, (n) => {
        if (n === 1) d.doc.body.innerHTML = LOBBY;
        if (n === 2) { d.doc.body.innerHTML = page; wireDialogButtons(d); }
      }, budget);
      check(`budget ${budget} ms, late lobby → ${name}: not admitted`, run.result === true, false);
      check(`budget ${budget} ms, late lobby → ${name}: escalated exactly once with a reason`,
        run.helpReasons.length === 1 && run.helpReasons[0].length > 0 && run.helpReasons[0] !== 'undefined', true);
      if (budget === 2_500) {
        check(`budget 2500 ms, late lobby → ${name}: reason ${expected}`, run.helpReasons.join(','), expected);
      }
      check(`budget ${budget} ms, late lobby → ${name}: nothing clicked`, d.clicks.length, 0);
    }
  }
  {
    // Lobby never goes away and the budget is shorter than a poll: the legit lobby timeout also surfaces help.
    const d = mount(LOBBY);
    const run = await runWait(d, undefined, 1_000);
    check('budget 1000 ms, lobby only → lobby_timeout', run.result, 'AdmissionError:lobby_timeout');
    check('budget 1000 ms, lobby only → escalated waiting_room_timeout_approaching', run.helpReasons.join(','), 'waiting_room_timeout_approaching');
  }

  console.log('\n=== a failing side effect cannot skip the escalation (review round 3 P2) ===');
  {
    // Screenshot rejects only at the final no-indicators checkpoint (budget shorter than a poll, lobby never leaves).
    const d = mount(LOBBY);
    const run = await runWait(d, undefined, 1_000, (page) => {
      page.screenshot = async (o: { path?: string }) => { if (o?.path?.includes('no-indicators')) throw new Error('screenshot failed'); };
    });
    check('screenshot fails at the no-indicators checkpoint → still lobby_timeout', run.result, 'AdmissionError:lobby_timeout');
    check('screenshot fails at the no-indicators checkpoint → escalated', run.helpReasons.join(','), 'waiting_room_timeout_approaching');
  }
  {
    // Late lobby then an unknown dialog; the same screenshot failure on the join_failure path.
    const d = mount('<div></div>');
    const run = await runWait(d, (n) => {
      if (n === 1) d.doc.body.innerHTML = LOBBY;
      if (n === 2) d.doc.body.innerHTML = `${TOOLBAR}<div role="dialog"><h2>Something unexpected</h2><button>OK</button></div>`;
    }, 2_500, (page) => {
      page.screenshot = async (o: { path?: string }) => { if (o?.path?.includes('no-indicators')) throw new Error('screenshot failed'); };
    });
    check('screenshot fails on the join_failure path → verdict unchanged', run.result, 'AdmissionError:join_failure');
    check('screenshot fails on the join_failure path → escalated unknown_blocking_state', run.helpReasons.join(','), 'unknown_blocking_state');
  }
  {
    // Every screenshot throws, including the very first one at the start of the wait: an unexpected error still
    // surfaces as join_failure AND escalates.
    const d = mount(LOBBY);
    const run = await runWait(d, undefined, 1_000, (page) => { page.screenshot = async () => { throw new Error('screenshot failed'); }; });
    check('every screenshot fails → join_failure', run.result, 'AdmissionError:join_failure');
    check('every screenshot fails → escalated, once, with a reason', run.helpReasons.length === 1 && run.helpReasons[0] !== 'undefined', true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
