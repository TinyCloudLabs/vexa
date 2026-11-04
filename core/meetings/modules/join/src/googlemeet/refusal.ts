/**
 * Google Meet refusing the knock itself — "You can't join this video call".
 *
 * Ported from upstream Vexa-ai/vexa#1921 (the v0.12.29 hotfix, itself a port of #1916) for TC-2443.
 *
 * Upstream reproduced it on its join harness (29 Oct 2026) and saw it in prod: Meet answers one of
 * two calls with HTTP 403 (gRPC PERMISSION_DENIED, "The caller does not have permission"):
 *   - `MeetingSpaceService/ResolveMeetingSpace`, ~3.5 s after the lobby loads, before any click;
 *   - `MeetingDeviceService/CreateMeetingDevice`, right after "Ask to join" / "Join now".
 * Either way no meeting device exists, so the host never receives a request; the page throws
 * `DisconnectedError, EndCause = 72, StartupCode = 200` and shows "You can't join this video call"
 * with a "Return to home screen" button, then redirects to workspace.google.com after 60 s.
 * (ResolveMeetingSpace answering 404 is a meeting code that does not exist: not this.)
 *
 * Before this module the bot waited out its 120 s name-input budget on a refusal during the lobby
 * load (a selector miss, TC-2443), or read the refusal screen's button as the waiting room (#471)
 * after the click and polled a page with nothing behind it for its whole lobby budget.
 *
 * The 403 is FLAKY on Google's side, not deterministic: upstream saw 27% of joins from a data-center
 * IP refused, and every refused bot got through on its second or third knock (same room, same
 * browser). So the bot re-knocks a bounded number of times, and when Meet keeps refusing it fails
 * fast with a typed `denial` whose message names the refusal — never a lobby wait, never "nobody
 * admitted the bot".
 */
import { Page } from "playwright";
import { log, logJSON } from "../_host";
import { AdmissionError } from "../shared/admission";
import { googleJoinRefusedIndicators } from "./selectors";

/** Reason code at the head of every refusal message; join evidence reads it as a platform refusal. */
export const GOOGLE_JOIN_REFUSED = "google_meet_join_refused";

/** Knocks per join, the first included. Meet's refusal is flaky; a meeting that refuses every one of
 *  these is reported as refused rather than knocked on until the lobby budget runs out. */
export const GOOGLE_JOIN_MAX_KNOCKS = 3;

/** The call whose 403 refused the knock; null when only the refusal screen was seen. */
export type GoogleRefusingCall = "ResolveMeetingSpace" | "CreateMeetingDevice";

// The two calls whose 403 is Meet refusing this join. Group 1 names the call in the evidence.
const REFUSING_RPC = /(MeetingSpaceService\/ResolveMeetingSpace|MeetingDeviceService\/CreateMeetingDevice)/;

// Static codes for the structured log; the bot's log sanitizer allowlists exactly these values.
const REFUSED_CALL_CODE: Record<GoogleRefusingCall | "screen", string> = {
  ResolveMeetingSpace: "resolve_meeting_space",
  CreateMeetingDevice: "create_meeting_device",
  screen: "refusal_screen",
};

// Per page: the refused call of the CURRENT knock, and whether the response listener is already
// attached. WeakMap/WeakSet so nothing outlives the page.
const refusedCall = new WeakMap<object, GoogleRefusingCall>();
const watched = new WeakSet<object>();

/**
 * Listen for Meet refusing the join. Idempotent per page; call it before navigating to the meeting
 * (ResolveMeetingSpace answers during the lobby load). The network answer is the primary signal: it
 * does not depend on the UI language and it outlives the refusal screen (which Meet replaces with a
 * redirect after 60 s).
 */
export function watchGoogleJoinRefusal(page: Page): void {
  const key = page as unknown as object;
  if (watched.has(key) || typeof (page as any).on !== "function") return;
  watched.add(key);
  page.on("response", (response) => {
    try {
      const call = response.status() === 403 ? REFUSING_RPC.exec(response.url())?.[1] : undefined;
      if (call) {
        const name = call.split("/")[1] as GoogleRefusingCall;
        refusedCall.set(key, name);
        log(`🚫 Google Meet refused the join: ${name} answered HTTP 403`);
      }
    } catch { /* a response we cannot read is not evidence */ }
  });
}

/** Forget the previous knock's refusal before knocking again on the same page. */
export function resetGoogleJoinRefusal(page: Page): void {
  refusedCall.delete(page as unknown as object);
}

/** What shows Meet refused this knock, or null. Either signal alone is enough. */
export async function checkForGoogleJoinRefused(page: Page): Promise<string | null> {
  const evidence: string[] = [];
  const call = refusedCall.get(page as unknown as object);
  if (call) evidence.push(`${call} answered HTTP 403`);
  for (const selector of googleJoinRefusedIndicators) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      evidence.push(`Meet showed "You can't join this video call"`);
      break;
    }
  }
  return evidence.length ? evidence.join("; ") : null;
}

/** One refused knock. A typed `denial`: Meet said no, and no host was ever asked. */
export class GoogleJoinRefusedError extends AdmissionError {
  readonly evidence: string;
  readonly call: GoogleRefusingCall | null;
  constructor(evidence: string, knocks = 1, call: GoogleRefusingCall | null = null) {
    super(
      "denial",
      `${GOOGLE_JOIN_REFUSED}: Google Meet refused the join on ${knocks} of ${knocks} knock${knocks === 1 ? "" : "s"} (${evidence}); ` +
        `the host never received a request to admit the bot`,
    );
    this.name = "GoogleJoinRefusedError";
    this.evidence = evidence;
    this.call = call;
  }
}

export async function throwIfGoogleJoinRefused(page: Page, context: string): Promise<void> {
  const evidence = await checkForGoogleJoinRefused(page);
  if (evidence) {
    log(`🚫 Google Meet refused the join (${evidence}, ${context})`);
    throw new GoogleJoinRefusedError(evidence, 1, refusedCall.get(page as unknown as object) ?? null);
  }
}

/**
 * Run one knock (`knock` = join click + admission wait) and knock again while Meet refuses it, up to
 * GOOGLE_JOIN_MAX_KNOCKS. Any other outcome — admitted, denied by the host, a lobby timeout, a crash,
 * a cancelled join — ends the loop as it is. `knock` receives the lobby budget still left, so
 * re-knocks never extend the wait the control plane issued.
 */
export async function knockUntilGoogleAccepts(
  page: Page,
  timeoutMs: number,
  knock: (remainingMs: number) => Promise<boolean>,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    resetGoogleJoinRefusal(page);
    try {
      return await knock(Math.max(deadline - now(), 0));
    } catch (e) {
      if (!(e instanceof GoogleJoinRefusedError)) throw e;
      // The bot's process log sanitizer keeps only allowlisted JSON fields, so this event is the
      // production record of each refused knock (the `log` lines in this module are dropped there).
      logJSON({
        level: "warn",
        event: "join.refused",
        platform: "google_meet",
        error_code: "join_refused",
        refused_call: REFUSED_CALL_CODE[e.call ?? "screen"],
        attempt,
        attempts_max: GOOGLE_JOIN_MAX_KNOCKS,
      });
      if (attempt >= GOOGLE_JOIN_MAX_KNOCKS || deadline - now() <= 0) {
        throw new GoogleJoinRefusedError(e.evidence, attempt, e.call);
      }
      log(`🔁 Google Meet refused knock ${attempt} of ${GOOGLE_JOIN_MAX_KNOCKS} (${e.evidence}); knocking again`);
    }
  }
}
