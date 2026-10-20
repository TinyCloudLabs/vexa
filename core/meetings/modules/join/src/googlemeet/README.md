# join/src/googlemeet — Google Meet join flow

Enter a Google Meet and resolve admission. `join.ts` (name entry + ask-to-join, humanized
or synthetic input), `admission.ts` (the lobby→admitted/rejected oracle, incl. bot-block
detection), `leave.ts`, `removal.ts` (kicked-out monitor), `selectors.ts` (DOM selectors).
`humanized/` holds the X11 mocap-driven input. Imports host symbols from `../_host`,
`playwright`, and Node builtins only.

## Consent policy: a human decides; one sanctioned exception

The bot never auto-clicks consent. A pre-admission Gemini "take notes for me" prompt (or any dialog that
asks for a decision) holds admission and summons a human (`needs_human_help`); see `hasConsentPrompt` in
`admission.ts`.

Exception (Sam, 2026-10-20, card tc1606-join-now-click: 'Yes, for this notice only'): the bot may press 'Join now' on Google Meet's post-admission notice that the call is being recorded, transcribed or note-taken by Gemini. It is the capturing party and has already been admitted by the host. Never auto-click anything that grants consent on behalf of others or shares data.

Scope, enforced in `gemini-notice.ts` by one accessible-tree check (and called from `admission.ts` only once the
lobby text is gone and a real participant tile is rendered). The bot presses "Join now" only if the dialog is a
visible `role="dialog"` (not `alertdialog`, not aria-hidden/inert, not nested in another dialog) and, walking its
whole tree including open shadow roots: (1) nothing is unknown (an iframe/object/embed, or a custom element without
an open shadow root, means no click); (2) there are exactly two focusable or interactive elements of any kind, both
real buttons (`<button>` or `role=button`); (3) for each, visible text == accessible name (aria-labelledby, then
aria-label, then text) == exactly "Leave" / "Join now"; (4) all other text is only the notice sentences ("This video
call is being recorded", "...transcribed", "Gemini is taking notes"). "Join now" is pressed at most 3 times, then the
bot escalates (`gemini_notice`). Anything else (an extra element, a name that differs from the text, the
`take notes for me` consent prompt) is not the notice and is never clicked.
Every unresolved exit of the admission wait escalates to `needs_human_help` with a reason, independent of loop
timing and of failing diagnostics (a failing screenshot cannot skip it), so a stall is never silent.
Each attempt emits the JSON event `join.gemini_notice_handled` (`success`, `attempt`), which survives the bot's
log sanitizer. Captured copies live in `fixtures/` (Gemini/transcription and recording-only).
