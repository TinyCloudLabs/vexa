# googlemeet/fixtures

Verbatim DOM captures from live Google Meet sessions, used by the no-browser tests. Each file's header comment
says when and how it was captured and what was stripped (instrumentation attributes only; no names, meeting
codes or URLs).

- `gemini-notice.captured.html` — the post-admission dialog "This video call is being transcribed. Gemini is
  taking notes." [Leave] [Join now] (meeting with Gemini notes + transcription on, anonymous guest).
- `recording-notice.captured.html` — the same dialog for a recording-only meeting: "This video call is being
  recorded" [Leave] [Join now].

Used by `../gemini-notice.test.ts`. Policy for the click: `../README.md` ("Consent policy").
