/**
 * The Teams anonymous-join origin guard.
 *
 * The bot joins Teams ANONYMOUSLY by design: it navigates a meetup-join link and
 * expects the anonymous pre-join screen. Teams can instead bounce that navigation to
 * the Microsoft OAuth sign-in host (`login.microsoftonline.com/common/oauth2/v2.0/authorize`),
 * where no pre-join, no name input, no "Join now" and no meeting toolbar will EVER exist.
 *
 * That condition is detected HERE, at the navigation boundary, and named: a sign-in page is
 * not a slow pre-join screen, and a bot on a sign-in page was never offered to a host for
 * admission — so it must never be reported as an admission/pre-join timeout.
 *
 * Deliberately NOT an `AdmissionError`: the JoinDriver adapter maps an AdmissionError onto a
 * bare `JoinOutcome`, and that branch of the orchestrator emits its terminal lifecycle event
 * with a completion reason but NO reason text — the discriminator would die at the seam. A
 * plain throw travels the orchestrator's join catch, which stamps `reason: String(e)` onto the
 * terminal event, so `reasonCode` + the redacted URL reach `last_error` where triage reads them.
 * Same no-seal-bump idiom as the bot's `control_plane_unreachable` tag: an existing
 * `CompletionReason` (`join_failure`, transient) carrying a discriminating reason text.
 */

/** Machine-readable discriminator: the navigation landed on a Microsoft sign-in host. */
export const TEAMS_AUTH_REDIRECT = "teams_auth_redirect";

/** Machine-readable discriminator: the pre-join never rendered and the page is on neither the
 *  requested host nor any Teams host — the flow is pointed at something that is not the meeting. */
export const TEAMS_OFF_MEETING_ORIGIN = "teams_off_meeting_origin";

export type TeamsJoinRedirectReason =
  | typeof TEAMS_AUTH_REDIRECT
  | typeof TEAMS_OFF_MEETING_ORIGIN;

/** Microsoft identity-platform sign-in hosts. An anonymous meetup-join that lands on one of
 *  these has been handed to OAuth, not to a meeting. */
const MICROSOFT_LOGIN_HOSTS = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
  "login.microsoft.com",
  "login.live.com",
  "login.windows.net",
  "login.microsoftonline.de",
];

/** Hosts that ARE the Teams web client (world-wide, GCC/DoD, and the cloud.microsoft rename). */
const TEAMS_HOST_SUFFIXES = [
  "teams.microsoft.com",
  "teams.live.com",
  "teams.microsoft.us",
  "teams.cloud.microsoft",
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True iff `url` is a Microsoft identity sign-in page. */
export function isMicrosoftLoginUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return MICROSOFT_LOGIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** True iff `url` is served by the Teams web client. */
export function isTeamsMeetingUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return TEAMS_HOST_SUFFIXES.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The hostname of the meeting link the join was asked to open (null when unparseable). */
export function meetingOriginHost(meetingUrl: string): string | null {
  return hostOf(meetingUrl);
}


/** The typed terminal for a Teams join that is not on the meeting. */
export class TeamsJoinRedirectError extends Error {
  readonly reasonCode: TeamsJoinRedirectReason;
  constructor(reasonCode: TeamsJoinRedirectReason) {
    super(reasonCode);
    this.name = "TeamsJoinRedirectError";
    this.reasonCode = reasonCode;
  }
}

/** Build the sign-in-redirect terminal for `currentUrl`. */
export function authRedirectError(_currentUrl: string): TeamsJoinRedirectError {
  return new TeamsJoinRedirectError(TEAMS_AUTH_REDIRECT);
}

/** Build the off-meeting-origin terminal for `currentUrl`. */
export function offMeetingOriginError(_currentUrl: string, _requestedHost: string | null): TeamsJoinRedirectError {
  return new TeamsJoinRedirectError(TEAMS_OFF_MEETING_ORIGIN);
}

/**
 * The verdict for a page that is not showing a Teams pre-join.
 *
 * `null` = keep going (still on a Teams host, or still on the host we were pointed at — a slow
 * pre-join is a legitimate reason to wait). Anything else is terminal and names why.
 */
export function classifyNonMeetingUrl(
  currentUrl: string,
  requestedHost: string | null,
): TeamsJoinRedirectError | null {
  if (isMicrosoftLoginUrl(currentUrl)) return authRedirectError(currentUrl);
  if (isTeamsMeetingUrl(currentUrl)) return null;
  const host = hostOf(currentUrl);
  if (host && requestedHost && host === requestedHost) return null;
  if (!host) return null;
  return offMeetingOriginError(currentUrl, requestedHost);
}
