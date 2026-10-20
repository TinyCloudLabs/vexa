import type { Page, ElementHandle } from "playwright";
import { log, logJSON } from "../_host";
import type { BotConfig } from "../_host";
import { triggerEscalation } from "../shared/escalation";
import {
  googleGeminiNoticeDialogSelectors,
  googleGeminiNoticeControlSelectors,
  googleGeminiNoticeSentences,
  googleGeminiNoticeCaptureSentenceCount,
  googleGeminiNoticeLeaveLabel,
  googleGeminiNoticeContinueLabel,
} from "./selectors";
import { HumanizedInteractor, MOCAP_LIBRARY } from "./humanized";
import { resolveUiInteractionMode } from "./join";

// ── The post-admission Gemini / transcription / recording NOTICE (TC-1606) ──────────────────────────
//
// OBSERVED live: after the host admits an anonymous guest into a meeting with Gemini notes, transcription
// or recording on, Meet shows the guest a modal dialog — "This video call is being transcribed. Gemini is
// taking notes." / "This video call is being recorded" — with exactly [Leave] [Join now]. The guest is not
// in the call until "Join now" is pressed, even though the call chrome is already rendered behind it.
//
// POLICY — exception to "consent is a human decision; never auto-click" (see admission.ts and README.md):
//   Exception (Sam, 2026-10-20, card tc1606-join-now-click: 'Yes, for this notice only'): the bot may press
//   'Join now' on Google Meet's post-admission notice that the call is being recorded, transcribed or
//   note-taken by Gemini. It is the capturing party and has already been admitted by the host. Never
//   auto-click anything that grants consent on behalf of others or shares data.
//
// The click is scoped to EXACTLY this shape: a visible `role="dialog"` (never `alertdialog`) whose text, minus
// the two control labels, consists only of the known notice sentences (recorded / transcribed / "Gemini is
// taking notes"), containing EXACTLY two interactive controls of any kind, named Leave and Join now. Any other
// dialog — the pre-admission "take notes for me" consent prompt, one with an extra button/link/checkbox/input
// (e.g. a share or allow control), one without "Join now" — is not the notice and is never clicked.
// admission.ts additionally calls it only once the bot is in the call (lobby gone, a real tile present).

/** How many times the click is attempted before the bot gives up and summons a human. */
export const GEMINI_NOTICE_MAX_CLICKS = 3;
/** Settle time after a click before admission is re-checked. */
const SETTLE_AFTER_CLICK_MS = 1000;

export interface GeminiNoticeScanArgs {
  dialogSelectors: string[];
  controlSelectors: string[];
  sentences: string[];
  captureSentenceCount: number;
  leaveLabel: string;
  continueLabel: string;
}

// Runs INSIDE the page (shipped through page.evaluateHandle), so it is self-contained by contract: DOM
// globals and its argument only, plain-CSS selectors only (document.querySelector has no Playwright
// engines). Matches by role + text, never by Google's generated class names. Returns the "Join now" button
// of the notice dialog, or null when the page is not showing the notice.
export function findGeminiNoticeContinueButton(args: GeminiNoticeScanArgs): Element | null {
  // Serialization contract (see shared/leave-click.ts): esbuild-family compilers wrap nested function
  // expressions in a `__name` helper that does not exist in the page. Define it before any nested function.
  // The identity is an anonymous argument on purpose: a named binding would itself be wrapped in `__name`.
  Reflect.set(globalThis, "__name", Reflect.get(globalThis, "__name") || ((f: unknown) => f));
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const isVisible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  const dialogs = Array.from(document.querySelectorAll(args.dialogSelectors.join(","))).filter(isVisible);
  for (const dialog of dialogs) {
    // EXACTLY two interactive controls, of any kind (hidden ones count: a conservative scope), named
    // exactly Leave and Join now. A checkbox, link, share/allow control or a third button disqualifies.
    const controls = Array.from(dialog.querySelectorAll(args.controlSelectors.join(",")));
    if (controls.length !== 2) continue;
    const labels = controls.map((c) => normalize(c.textContent || ""));
    if (!labels.includes(args.leaveLabel) || !labels.includes(args.continueLabel)) continue;
    if (!controls.every(isVisible)) continue;
    // The dialog text with the control labels removed must consist ONLY of the known notice sentences.
    const clone = dialog.cloneNode(true) as Element;
    for (const c of Array.from(clone.querySelectorAll(args.controlSelectors.join(",")))) c.remove();
    const sentences = normalize(clone.textContent || "").split(".").map((x) => x.trim()).filter((x) => x.length > 0);
    if (sentences.length === 0 || !sentences.every((x) => args.sentences.includes(x))) continue;
    if (!sentences.some((x) => args.sentences.indexOf(x) < args.captureSentenceCount)) continue;
    return controls[labels.indexOf(args.continueLabel)];
  }
  return null;
}

const scanArgs: GeminiNoticeScanArgs = {
  dialogSelectors: googleGeminiNoticeDialogSelectors,
  controlSelectors: googleGeminiNoticeControlSelectors,
  sentences: googleGeminiNoticeSentences,
  captureSentenceCount: googleGeminiNoticeCaptureSentenceCount,
  leaveLabel: googleGeminiNoticeLeaveLabel,
  continueLabel: googleGeminiNoticeContinueLabel,
};

/** Handle to the notice's "Join now" button, or null. The caller owns (and must dispose) the handle. */
async function findContinueHandle(page: Page): Promise<ElementHandle<Element> | null> {
  try {
    const handle = await page.evaluateHandle(findGeminiNoticeContinueButton, scanArgs);
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    return element;
  } catch {
    // A page that cannot be evaluated (navigating, closed) is not evidence of a notice.
    return null;
  }
}

export async function detectGeminiNotice(page: Page): Promise<{ present: boolean }> {
  const handle = await findContinueHandle(page);
  if (!handle) return { present: false };
  await handle.dispose().catch(() => {});
  return { present: true };
}

interface NoticeState {
  attempts: number;
  escalated: boolean;
}
// Per page, so a bot's pages never share counters and nothing leaks after the page is gone.
const noticeState = new WeakMap<object, NoticeState>();

// Click via humanized OS-level input when available (Meet's input-authenticity checks), falling back to a
// synthetic handle click, exactly like the lobby CTA in join.ts.
async function clickContinue(page: Page, botConfig: BotConfig, handle: ElementHandle<Element>): Promise<void> {
  if (resolveUiInteractionMode(botConfig) === "humanized") {
    const humanizer = new HumanizedInteractor(MOCAP_LIBRARY, { log });
    if (await humanizer.available()) {
      try {
        await humanizer.navigateAndClick(page, handle);
        return;
      } catch {
        log("Gemini notice: humanized click failed; using synthetic click");
      }
    }
  }
  await handle.click();
}

export type GeminiNoticeOutcome = "absent" | "clicked" | "exhausted";

/**
 * If the page shows the post-admission notice, press its "Join now" (the sanctioned exception above).
 * Emits `join.gemini_notice_handled` per click attempt (sanitizer-allowlisted JSON; `success` = the click
 * was delivered, `attempt` = 1-based). After GEMINI_NOTICE_MAX_CLICKS attempts with the notice still up,
 * escalates once to needs_human_help (reason `gemini_notice`) instead of clicking forever.
 * The caller re-checks admission afterwards; this never decides admission itself.
 */
export async function handleGeminiNotice(page: Page, botConfig: BotConfig): Promise<GeminiNoticeOutcome> {
  const handle = await findContinueHandle(page);
  if (!handle) return "absent";
  try {
    const state = noticeState.get(page) ?? { attempts: 0, escalated: false };
    noticeState.set(page, state);
    if (state.attempts >= GEMINI_NOTICE_MAX_CLICKS) {
      if (!state.escalated) {
        state.escalated = true;
        await triggerEscalation(botConfig, "gemini_notice");
      }
      return "exhausted";
    }
    const attempt = ++state.attempts;
    let delivered = true;
    try {
      await clickContinue(page, botConfig, handle);
    } catch {
      delivered = false;
    }
    logJSON({ level: delivered ? "info" : "warn", event: "join.gemini_notice_handled", platform: "google_meet", success: delivered, attempt });
    await page.waitForTimeout(SETTLE_AFTER_CLICK_MS);
    return "clicked";
  } finally {
    await handle.dispose().catch(() => {});
  }
}
