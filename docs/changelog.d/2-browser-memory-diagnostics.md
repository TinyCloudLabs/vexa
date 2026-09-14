- **Late joiners now land in the batch recording (TinyCloudLabs/vexa#1).** The recording tap builds its audio mix
  dynamically instead of grabbing the page's media elements once at start: a participant whose
  audio arrives after the bot joined is attached to `master.webm`, a room with nobody audible at
  join still produces a recording, and ended or removed tracks detach without breaking the run.
  See [Retrieve a meeting recording](/how-to/recordings).
- **Reduce capture buffer retention and preserve browser failure reasons (TinyCloudLabs/vexa#2).** PCM worklets transfer
  completed buffers instead of copying them, and the recording mixer avoids repeatedly capturing
  video-only streams and releases its own fallback tracks. Browser crash/close events now produce
  failed lifecycle reports with resource evidence instead of waiting for a silence timeout.
- **Keep recording shutdown in order.** The final marker follows pending blob conversions, and
  the bot waits for queued recording uploads before finishing shutdown. These changes do not
  guarantee delivery after a permanent upload failure; long Google Meet acceptance is separate
  from the synthetic component tests.
- **Tinfoil documented as an OpenAI-compatible STT endpoint (fork overlay).** Configuration only — Google Meet
  capture, speaker channels, speech windows, silence gates, hallucination filtering, and timing stay
  in the Vexa pipeline; the backend supplies text. A live account probe is still pending.
  See [Use a custom STT endpoint](/how-to/custom-stt).
