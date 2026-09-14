- **Reduce capture buffer retention and preserve browser failure reasons (#1).** PCM worklets transfer
  completed buffers instead of copying them, and the recording mixer avoids repeatedly capturing
  video-only streams and releases its own fallback tracks. Browser crash/close events now produce
  failed lifecycle reports with resource evidence instead of waiting for a silence timeout.
- **Keep recording shutdown in order.** The final marker follows pending blob conversions, and
  the bot waits for queued recording uploads before finishing shutdown. These changes do not
  guarantee delivery after a permanent upload failure; long Google Meet acceptance is separate
  from the synthetic component tests.
