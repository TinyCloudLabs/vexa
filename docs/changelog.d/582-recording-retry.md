- **Meeting bot: a transient recording upload failure no longer ends the mixed recording (TC-582).**
  When a recording chunk upload hits a network error, a timeout, a 408/429, or a 5xx from the
  meeting-api, the bot keeps that chunk at the head of its upload queue and retries it with capped,
  jittered exponential backoff instead of giving up after one round of attempts. The browser keeps
  recording into its bounded buffer meanwhile, so an outage shorter than that buffer (about 18
  minutes) loses no audio and the recording stays byte-contiguous. Non-retryable errors still fail
  the recording closed without claiming completion.
