- **Google Meet: a refused knock is retried, not waited out (TC-2443, port of upstream #1921).** Meet
  sometimes refuses a guest join with HTTP 403 on `ResolveMeetingSpace` (while the lobby loads) or
  `CreateMeetingDevice` (right after "Ask to join"), and shows "You can't join this video call"; the host
  never receives a request. The bot used to wait out its 120 s name-input budget and fail as a selector
  miss, or read the refusal screen as the waiting room. It now asks again, up to 3 times within the same
  lobby budget (Meet's refusal is intermittent), and if Meet keeps refusing it fails fast as
  `awaiting_admission_rejected` with the reason `google_meet_join_refused`, attributed to the platform.
  Each refused knock logs one sanitized `join.refused` event that names the refusing call.
