import type { Page, ElementHandle } from "playwright";
import { log, logJSON } from "../_host";
import type { BotConfig } from "../_host";
import { triggerEscalation } from "../shared/escalation";
import {
  googleGeminiNoticeDialogSelectors,
  googleGeminiNoticeBlockingDialogSelectors,
  googleGeminiNoticeModalSelectors,
  googleGeminiNoticeBlockingTexts,
  googleGeminiNoticeControlSelectors,
  googleGeminiNoticeButtonSelectors,
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
// taking notes"), containing EXACTLY two focusable/interactive elements of any kind, both real buttons, named Leave and Join now. Any other
// dialog — the pre-admission "take notes for me" consent prompt, one with an extra button/link/checkbox/input
// (e.g. a share or allow control), one without "Join now" — is not the notice and is never clicked.
// admission.ts additionally calls it only once the bot is in the call (lobby gone, a real tile present).

/** How many times the click is attempted before the bot gives up and summons a human. */
export const GEMINI_NOTICE_MAX_CLICKS = 3;
/** Settle time after a click before admission is re-checked. */
const SETTLE_AFTER_CLICK_MS = 1000;

export interface GeminiNoticeScanArgs {
  /** "click": return the Join now button of exactly the notice (or null). "block": return true when ANY dialog
   *  in the tree (open shadow roots included) says capture is on, clickable or not. "modal": return true when ANY
   *  modal dialog is present (aria-modal, open <dialog>, or a dialog covering the middle of the viewport), whatever
   *  it says — the fail-safe for notices we cannot read. Same walk for all three. */
  mode: "click" | "block" | "modal";
  dialogSelectors: string[];
  blockingDialogSelectors: string[];
  modalSelectors: string[];
  blockingTexts: string[];
  controlSelectors: string[];
  buttonSelectors: string[];
  sentences: string[];
  captureSentenceCount: number;
  leaveLabel: string;
  continueLabel: string;
}

// Runs INSIDE the page (shipped through page.evaluateHandle), so it is self-contained by contract: DOM globals
// and its argument only, plain-CSS selectors only (document.querySelector has no Playwright engines).
// Returns the "Join now" button of the notice dialog, or null when the page is not showing exactly the notice.
//
// ONE accessible-tree check, no per-probe special cases. The dialog is accepted only if, walking its WHOLE tree
// (light DOM and every open shadow root), ALL of these hold:
//   1. it is a visible `role="dialog"`, not aria-hidden/inert, with no dialog/alertdialog ancestor (a nested
//      dialog inside a consent dialog is not the notice);
//   2. nothing in the tree is "unknown": an iframe/frame/object/embed, or a custom element without an open
//      shadow root (it may host a closed one, which cannot be inspected) — unknown means no click;
//   3. exactly two focusable/interactive elements exist in that full tree, both real buttons, both visible;
//   4. each button's visible text, its accessible name (aria-labelledby, then aria-label, then text — the same
//      algorithm for both) and the expected label ("leave" / "join now") are all equal after normalization;
//   5. every other text node in the tree, joined, consists only of the known notice sentences.
// Matches by role + text, never by Google's generated class names.
export function findGeminiNoticeContinueButton(args: GeminiNoticeScanArgs): Element | boolean | null {
  // Serialization contract (see shared/leave-click.ts): esbuild-family compilers wrap nested function
  // expressions in a `__name` helper that does not exist in the page. Define it before any nested function.
  // The identity is an anonymous argument on purpose: a named binding would itself be wrapped in `__name`.
  Reflect.set(globalThis, "__name", Reflect.get(globalThis, "__name") || ((f: unknown) => f));
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const shown = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  const controlSel = args.controlSelectors.join(",");
  const buttonSel = args.buttonSelectors.join(",");
  const dialogSel = args.dialogSelectors.join(",");
  const nestedDialogSel = '[role="dialog"],[role="alertdialog"],dialog';
  const UNKNOWN_TAGS = ["iframe", "frame", "object", "embed"];

  // Parent across shadow boundaries (a shadow root's parent is its host).
  const parentOf = (n: Node): Element | null => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode() as unknown as { host?: Element };
    return root && root.host ? root.host : null;
  };

  // Text of an element as a user sees it: text nodes whose own ancestors (up to the element) are rendered.
  const visibleText = (el: Element): string => {
    const parts: string[] = [];
    const stack: Node[] = [el];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      if (node.nodeType === 3) {
        let ok = true;
        for (let p = node.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.display === "none" || cs.visibility === "hidden") ok = false;
          if (p === el) break;
        }
        if (ok) parts.push(node.textContent || "");
      } else {
        const kids = Array.from(node.childNodes);
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        const host = node as Element;
        if (host.shadowRoot) stack.push(host.shadowRoot);
      }
    }
    return normalize(parts.join(" "));
  };

  // Accessible name, one algorithm for every control: aria-labelledby, then aria-label, then text.
  const accessibleName = (el: Element): string => {
    const root = el.getRootNode() as unknown as { getElementById?: (id: string) => Element | null };
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby && root.getElementById) {
      const named = labelledby.split(/\s+/).map((id) => {
        const ref = root.getElementById ? root.getElementById(id) : null;
        return ref ? normalize(ref.getAttribute("aria-label") || ref.textContent || "") : "";
      }).filter((t) => t.length > 0).join(" ");
      if (named.length > 0) return named;
    }
    const label = normalize(el.getAttribute("aria-label") || "");
    if (label.length > 0) return label;
    return visibleText(el);
  };

  // Candidate dialogs: found recursively through every OPEN shadow root, not just the light DOM, so a notice
  // hosted in a shadow root is seen by the click check and by the admission guard alike.
  const modalSel = args.modalSelectors.join(",");
  const candidateSel = args.mode === "block" ? args.blockingDialogSelectors.join(",")
    : args.mode === "modal" ? args.blockingDialogSelectors.concat(args.modalSelectors).join(",")
      : dialogSel;
  const dialogs: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let r = 0; r < roots.length; r++) {
    for (const el of Array.from(roots[r].querySelectorAll("*"))) {
      if (el.matches(candidateSel) && shown(el)) dialogs.push(el);
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  if (args.mode === "modal") {
    // A candidate is modal if it says so, or if it covers the middle of the viewport (the call UI is covered).
    const cx = Math.floor((window.innerWidth || 0) / 2);
    const cy = Math.floor((window.innerHeight || 0) / 2);
    let hit: Element | null = null;
    try {
      hit = document.elementFromPoint(cx, cy);
      // Chromium retargets the document-level hit to an open-shadow HOST: descend through every open shadow
      // root with that root's own hit-test until it settles on the deepest element.
      for (let depth = 0; hit && hit.shadowRoot && depth < 32; depth++) {
        const inner: Element | null = hit.shadowRoot.elementFromPoint(cx, cy);
        if (!inner || inner === hit) break;
        hit = inner;
      }
    } catch { /* keep whatever was resolved; a failed hit-test only loses the "covering" signal */ }
    for (const dialog of dialogs) {
      if (dialog.matches(modalSel)) return true;
      for (let p: Element | null = hit; p; p = parentOf(p)) if (p === dialog) return true;
    }
    return false;
  }
  for (const dialog of dialogs) {
    // 1. the dialog itself: not hidden from the accessibility tree, not nested in another dialog.
    let blocked = false;
    for (let p: Element | null = dialog; p; p = parentOf(p)) {
      if (p.getAttribute("aria-hidden") === "true" || p.hasAttribute("inert")) blocked = true;
      if (p !== dialog && p.matches(nestedDialogSel)) blocked = true;
    }
    if (blocked && args.mode === "click") continue;

    // 2./3. walk the whole tree (open shadow roots included): collect controls and stray text, flag unknowns.
    const controls: Element[] = [];
    const strayText: Text[] = [];
    let unknown = false;
    const stack: Node[] = [dialog];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      if (node.nodeType === 3) { strayText.push(node as Text); continue; }
      if (node.nodeType === 1) {
        const el = node as Element;
        if (el !== dialog) {
          if (UNKNOWN_TAGS.indexOf(el.localName) >= 0) unknown = true;
          if (el.localName.indexOf("-") >= 0 && !el.shadowRoot) unknown = true;
          if (el.matches(controlSel)) controls.push(el);
        }
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
      const kids = Array.from(node.childNodes);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    if (args.mode === "block") {
      // Admission guard: any visible dialog that says capture is on blocks, whatever else it contains.
      const allText = normalize(strayText.map((t) => t.textContent || "").join(" "));
      if (args.blockingTexts.some((t) => allText.includes(t))) return true;
      continue;
    }
    if (unknown || controls.length !== 2) continue;
    if (!controls.every((c) => c.matches(buttonSel) && shown(c))) continue;

    // 4. accessible name == visible text == the expected label, for each button.
    const labels: string[] = [];
    let named = true;
    for (const c of controls) {
      const text = visibleText(c);
      if (text !== accessibleName(c)) named = false;
      labels.push(text);
    }
    if (!named || !labels.includes(args.leaveLabel) || !labels.includes(args.continueLabel)) continue;

    // 5. everything else on the dialog is the known notice sentences.
    const prose = strayText
      .filter((t) => !controls.some((c) => c.contains(t)))
      .map((t) => t.textContent || "").join(" ");
    const sentences = normalize(prose).split(".").map((x) => x.trim()).filter((x) => x.length > 0);
    if (sentences.length === 0 || !sentences.every((x) => args.sentences.includes(x))) continue;
    if (!sentences.some((x) => args.sentences.indexOf(x) < args.captureSentenceCount)) continue;

    return controls[labels.indexOf(args.continueLabel)];
  }
  return args.mode === "block" ? false : null;
}

const scanArgs: Omit<GeminiNoticeScanArgs, "mode"> = {
  blockingDialogSelectors: googleGeminiNoticeBlockingDialogSelectors,
  modalSelectors: googleGeminiNoticeModalSelectors,
  blockingTexts: googleGeminiNoticeBlockingTexts,
  dialogSelectors: googleGeminiNoticeDialogSelectors,
  controlSelectors: googleGeminiNoticeControlSelectors,
  buttonSelectors: googleGeminiNoticeButtonSelectors,
  sentences: googleGeminiNoticeSentences,
  captureSentenceCount: googleGeminiNoticeCaptureSentenceCount,
  leaveLabel: googleGeminiNoticeLeaveLabel,
  continueLabel: googleGeminiNoticeContinueLabel,
};

/** Handle to the notice's "Join now" button, or null. The caller owns (and must dispose) the handle. */
async function findContinueHandle(page: Page): Promise<ElementHandle<Element> | null> {
  try {
    const handle = await page.evaluateHandle(findGeminiNoticeContinueButton, { ...scanArgs, mode: "click" as const });
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

/**
 * True when ANY visible dialog anywhere in the tree (open shadow roots included) says the call is being
 * recorded / transcribed / note-taken. Admission is declared only when this is false: a notice that is not
 * exactly the clickable one (extra control, alertdialog, shadow-hosted variant) still means the guest may be
 * held outside the call, and must never read as admitted.
 */
export async function hasBlockingNoticeDialog(page: Page): Promise<boolean> {
  try {
    return (await page.evaluate(findGeminiNoticeContinueButton, { ...scanArgs, mode: "block" as const })) === true;
  } catch {
    return false;
  }
}

/**
 * True when ANY modal dialog is on screen (aria-modal, open <dialog>, or a dialog covering the middle of the
 * viewport), open shadow roots included, whatever it says. Admission is declared only when this is false:
 * an unreadable notice (reworded, localized, new) behind which the tile is already rendered must never read as
 * admitted. Non-modal toasts and pills do not count.
 */
export async function hasModalDialog(page: Page): Promise<boolean> {
  try {
    return (await page.evaluate(findGeminiNoticeContinueButton, { ...scanArgs, mode: "modal" as const })) === true;
  } catch {
    return false;
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
