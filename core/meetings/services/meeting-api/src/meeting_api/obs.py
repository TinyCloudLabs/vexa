"""Process-boundary logging and request trace propagation for meeting-api.

Structured events and ordinary Python/Uvicorn records share the same allowlist sanitizer. Trace
headers remain available to request handling but are never emitted as log data.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import re
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from starlette.middleware.base import BaseHTTPMiddleware

SERVICE = "meeting-api"
TRACE_HEADER = "x-trace-id"
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SAFE_EVENTS = {
    "request_failed", "lifecycle_event_rejected", "lifecycle_rehydrate_failed",
    "lifecycle_refresh_failed", "lifecycle_persist_failed", "transcript_finalize_failed",
    "service_provenance_persist_failed", "system_webhook_delivery",
    "system_webhook_delivery_failed", "webhook_delivery", "webhook_ledger_failed",
    "webhook_deliver_failed", "ws_status_publish_failed",
    "user_meeting_status_publish_failed", "meeting_copilot_reap_signalled",
    "meeting_copilot_reap_failed", "meeting_lifecycle_advanced", "runtime_callback",
    "runtime_callback_terminal_error", "auto_join_failed", "auto_join_skipped_live",
    "auto_join_skipped_uncapped", "auto_join_stopped", "auto_join_spawned",
    "bot_spawn_stop_terminalize_failed", "bot_spawn_stt_backend_unhealthy",
    "bot_spawn_continue_refused_stopped", "bot_spawn_auth_session_busy",
    "bot_spawn_max_bots_exceeded", "bot_spawn_fenced_by_stop", "bot_spawn_quota_exceeded",
    "bot_spawn_fail_row_error", "bot_spawn_failed", "bot_spawn_orphan_teardown_failed",
    "bot_spawn_post_spawn_db_failed", "bot_spawn_raced_stop_torn_down",
    "bot_spawn_raced_stop_teardown_failed", "bot_join_requested",
    "transcript_not_found", "transcript_served", "transcripts_searched", "meetings_listed",
    "bots_listed", "bots_status", "meeting_planned", "meeting_plan_updated",
    "meeting_artifacts_deleted", "meeting_plan_deleted", "meeting_annotated",
    "participants_not_found", "participants_served", "meeting_workspace_bound",
    "transcript_share_mint_failed", "transcript_share_minted", "segment_publish_failed",
    "stop_reconcile_orphan_kill_unconfirmed", "stop_reconcile_orphan_kill_failed",
    "meeting_workload_untracked", "meeting_workload_untracked_escalated",
    "stop_cancelled_planned", "stop_evicted_siblings", "stop_workload_teardown_unconfirmed",
    "stop_workload_teardown_failed", "recording_completed", "signal_tape_stored",
    "recording_chunk_count_mismatch", "recording_master_reassembled",
    "meeting_doc_connected", "meeting_doc_disconnected", "transcript_share_accepted",
    "meeting_intent_set", "ws_subscribe_authorized",
    "signal_tape_evict_failed", "signal_tape_evicted", "signal_tape_budget_unreclaimable",
    "signal_tape_budget_swept", "webhook_dead_lettered",
}
_SAFE_SPANS = {
    "lifecycle.callback", "runtime.callback", "bots.create", "meetings.auto_join",
    "transcripts.get_by_id", "transcripts.search", "transcripts.get", "meetings.list",
    "bots.list", "bots.status", "meetings.plan", "meetings.plan.update",
    "meetings.artifacts.delete", "meetings.plan.delete", "meetings.annotate",
    "meetings.docs.connect", "meetings.docs.disconnect", "meetings.intent.set",
    "ws.authorize_subscribe", "reconcile.stop",
    "meetings.participants", "meetings.workspace.bind", "meetings.transcript.share",
    "collector.ingest", "meetings.intent.publish", "reconcile.liveness", "bots.stop",
    "recordings.upload", "recordings.signal", "recordings.finalize",
    "recordings.signal.janitor", "webhook.retry_drain",
}
_SAFE_ENUMS = {
    "audience": {"user", "operator", "system"},
    "level": {"debug", "info", "warning", "error", "critical"},
    "platform": {"google_meet", "zoom", "teams", "msteams", "unknown"},
    "status": {"requested", "joining", "awaiting_admission", "active", "needs_human_help",
               "stopping", "completed", "failed", "scheduled", "deleted", "idle"},
    "meeting_status": {"requested", "joining", "awaiting_admission", "active", "needs_human_help",
                      "stopping", "completed", "failed", "scheduled", "deleted", "idle"},
    "outcome": {"delivered", "suppressed", "blocked", "failed", "queued"},
    "reason": {
        "schema_violation", "configuration", "quota_exceeded", "stt_unhealthy",
        "schedule_exhausted", "max_age_exceeded",
    },
    "error_code": {
        "transport_timeout", "transport_connection_error", "transport_exception",
        "http_failure", "other",
    },
    "phase": {"before_workload_create"},
    "event_type": {"meeting.started", "meeting.completed", "meeting.status_change", "bot.failed"},
    "media_type": {"audio", "video", "signal"},
    "mode": {"open", "restricted"},
    "intent": {"idle", "scheduled"},
    "raced_status": {"requested", "joining", "active", "stopping", "completed", "failed"},
    "error_type": {"RuntimeError", "ValueError", "TimeoutError", "OSError", "StatementError"},
}
_SAFE_NUMERIC_FIELDS = {
    "status_code", "segments", "hits", "query_chars", "count", "running", "active",
    "cap", "recordings", "objects", "bytes", "parts", "age_s", "promoted_bytes",
    "budget_bytes", "tapes", "evicted", "evicted_bytes", "attempt", "attempts",
    "max_attempts", "delay_s", "session_count", "docs",
}
_RECORD_FIELDS = {
    "event", "audience", "span", "meeting_id", "fields", "status_code", "trace_id",
    "levelname", "name", "created", "levelno",
}
_LOG_RECORD_KEYS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


def _meeting_hash(value: Any) -> Optional[str]:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    raw = str(value)
    if not raw.isdigit() or len(raw) > 20:
        return None
    return hashlib.sha256(raw.encode("ascii")).hexdigest()[:16]


def _safe_fields(fields: Any) -> dict:
    if not isinstance(fields, dict):
        return {}
    safe = {}
    for key, value in fields.items():
        if key in _SAFE_NUMERIC_FIELDS and isinstance(value, (int, float)) and not isinstance(value, bool):
            safe[key] = value
        elif isinstance(value, bool) and key in {
            "title", "stop_requested", "over_budget", "continued", "has_link", "changed", "has_target",
        }:
            safe[key] = value
        elif key in _SAFE_ENUMS and isinstance(value, str) and value in _SAFE_ENUMS[key]:
            safe[key] = value
    return safe


class PrivacyFilter(logging.Filter):
    """Allowlist the process boundary; logs carry diagnostics, never user-shaped data."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = record.name
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        for key in tuple(record.__dict__):
            if key not in _RECORD_FIELDS and key not in _LOG_RECORD_KEYS:
                del record.__dict__[key]
        if "status_code" in record.__dict__:
            status = record.status_code
            if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
                record.__dict__.pop("status_code", None)
        if not isinstance(getattr(record, "event", None), str) or record.event not in _SAFE_EVENTS:
            record.event = "log_event"
        if getattr(record, "audience", None) not in _SAFE_ENUMS["audience"]:
            record.audience = "system"
        span = getattr(record, "span", None)
        record.span = span if isinstance(span, str) and span in _SAFE_SPANS else None
        meeting_id = _meeting_hash(getattr(record, "meeting_id", None))
        if meeting_id is None:
            record.__dict__.pop("meeting_id", None)
        else:
            record.meeting_id = meeting_id
        trace_id = getattr(record, "trace_id", None)
        if not isinstance(trace_id, str) or not _TRACE_ID_RE.fullmatch(trace_id):
            trace_id = _trace_id.get() or new_trace_id()
        record.trace_id = trace_id
        if hasattr(record, "fields"):
            record.fields = _safe_fields(record.fields)
        return True


logging.getLogger().addFilter(PrivacyFilter())


class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "service": SERVICE,
            "event": record.event,
            "audience": record.audience,
            "trace_id": record.trace_id,
        }
        if getattr(record, "span", None):
            payload["span"] = record.span
        if getattr(record, "meeting_id", None):
            payload["meeting_id"] = record.meeting_id
        if getattr(record, "fields", None):
            payload["fields"] = record.fields
        if getattr(record, "status_code", None) is not None:
            payload["status_code"] = record.status_code
        return json.dumps(payload, separators=(",", ":"))


def configure_privacy_logging() -> None:
    privacy_filter = PrivacyFilter()
    root = logging.getLogger()
    root.addFilter(privacy_filter)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.addFilter(privacy_filter)
        for handler in logger.handlers:
            handler.addFilter(privacy_filter)


LOG_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"privacy": {"()": "meeting_api.obs.PrivacyFilter"}},
    "formatters": {"json": {"()": "meeting_api.obs.JSONFormatter"}},
    "handlers": {
        "default": {"class": "logging.StreamHandler", "formatter": "json", "filters": ["privacy"], "stream": "ext://sys.stderr"},
        "access": {"class": "logging.StreamHandler", "formatter": "json", "filters": ["privacy"], "stream": "ext://sys.stderr"},
    },
    "loggers": {
        "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.access": {"handlers": ["access"], "level": "INFO", "propagate": False},
    },
    "root": {"handlers": ["default"], "level": "INFO"},
}

_trace_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("trace_id", default=None)
_user_id: contextvars.ContextVar[Optional[Any]] = contextvars.ContextVar("user_id", default=None)


def new_trace_id() -> str:
    return uuid.uuid4().hex
def valid_trace_id(value: Any) -> str:
    return value if isinstance(value, str) and _TRACE_ID_RE.fullmatch(value) else new_trace_id()




def get_trace_id() -> Optional[str]:
    return _trace_id.get()


def set_trace_id(trace_id: str) -> contextvars.Token:
    return _trace_id.set(trace_id)


def set_user_id(user_id: Any) -> contextvars.Token:
    return _user_id.set(user_id)


def log_event(
    event: str,
    *,
    audience: str,
    level: str = "info",
    span: Optional[str] = None,
    user_id: Any = None,
    meeting_id: Optional[str] = None,
    fields: Optional[dict] = None,
    stream=None,
    trace_id: Optional[str] = None,
) -> dict:
    """Emit a sanitized ``logevent.v1`` JSON record and return its safe envelope."""
    record = logging.LogRecord(
        SERVICE, getattr(logging, str(level).upper(), logging.INFO), "", 0,
        SERVICE, (), None,
    )
    record.event = event
    record.audience = audience
    record.span = span
    record.meeting_id = meeting_id
    record.trace_id = valid_trace_id(trace_id or _trace_id.get())
    record.fields = fields or {}
    PrivacyFilter().filter(record)
    formatted = JSONFormatter().format(record)
    if record.levelno >= logging.INFO:
        print(formatted, file=stream or sys.stdout, flush=True)
    return json.loads(formatted)


class TraceMiddleware(BaseHTTPMiddleware):
    """Read ``X-Trace-Id`` for the response but never expose arbitrary headers in logs."""

    async def dispatch(self, request, call_next):
        incoming = request.headers.get(TRACE_HEADER)
        trace_id = valid_trace_id(incoming)
        token = _trace_id.set(trace_id)
        try:
            request.state.trace_id = trace_id
            response = await call_next(request)
            response.headers[TRACE_HEADER] = trace_id
            return response
        finally:
            _trace_id.reset(token)
