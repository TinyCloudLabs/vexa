- **Meeting bot: a Google Meet bot whose remote audio is cut off now rejoins instead of waiting out the silence window (TC-903).**
  The bot checks the meeting page every 2 seconds. When every remote audio track has ended for 25
  seconds while other participants are still in the call, it leaves, rejoins the same meeting in the
  same bot process, and resumes transcription capture on the new page. The lifecycle stays `active`.
  A rejoin that is not admitted ends the run `failed` (`join_failure`, reason `rejoin_<outcome>`).
  At most 2 rejoins happen per run. Genuine silence, an emptied room and host removal end the run
  exactly as before. The recording master ends at the media loss, because a second recorder stream
  cannot be appended to it. This mechanism is proven offline only; a live Google Meet validation is
  still open.
