"""Structured, trace-correlated logging — conforms to ``logevent.v1``.

This is the gateway lane's PRODUCTION emitter (promoted out of the conformance harness).
The SHARED SSOT is the ``logevent.v1`` CONTRACT, not shared code: the real ``meeting-api``
and ``runtime`` services each carry their OWN equivalent emitter bound to their own service
name — duplicated ~by design so no cross-domain Python import crosses the ``services/`` seam.
The wire format (the JSON envelope) is identical because all conform to the one contract.

It provides:
  * a ``trace_id`` propagated via ``contextvars`` (one ContextVar per process),
  * ``log_event(...)`` which emits ONE JSON line conforming to ``logevent.v1``,
  * ``TraceMiddleware`` — a FastAPI/Starlette middleware that reads/sets the ``X-Trace-Id``
    header: MINTS a trace_id at the edge when absent, binds it for the request, echoes it on
    the response. Downstream hops forward the SAME id so every hop's logs share it.

The core is a tiny factory keyed by service name (``make_log_event`` / ``make_trace_middleware``)
so the in-process conformance chain can stand up a second emitter for the downstream hop
(service ``"meeting-api"``) that shares these MODULE-GLOBAL contextvars — modelling, in one
process, the contextvar propagation the real cross-process services get via ``X-Trace-Id``.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import logging.config
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from starlette.middleware.base import BaseHTTPMiddleware
_TRACE_ID_RE = re.compile(r"^[0-9a-fA-F]{32}$")
_ROUTE_RE = re.compile(r"^/[A-Za-z0-9_./{}-]{1,200}$")
_ROUTE_SEGMENT_RE = re.compile(r"^(?:[A-Za-z_]+|v[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})$")
_SAFE_FIELDS = {
    "method", "route", "minted", "downstream_status", "status", "required",
    "reason", "count", "duration_ms", "bytes",
}
_LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}
_SCOPE_NAMES = {"bot", "tx", "browser", "admin", "recording", "mcp"}
_SAFE_REASONS = {"AuthUnavailable"}
_SAFE_EVENTS = {
    "request_received", "auth_infra_unavailable", "request_denied_undeclared_route",
    "request_denied_scope", "request_accepted", "downstream_forwarded",
    "downstream_stream_opened", "bot_join_requested",
}
_SAFE_SPANS = {"edge", "auth", "proxy", "ws"}
_SAFE_SERVICES = {"gateway", "meeting-api"}


def _is_route_template(value: str) -> bool:
    return bool(
        _ROUTE_RE.fullmatch(value)
        and all(_ROUTE_SEGMENT_RE.fullmatch(part) for part in value.strip("/").split("/"))
    )


def _safe_trace_id(value: Optional[str]) -> str:
    return value if isinstance(value, str) and _TRACE_ID_RE.fullmatch(value) else new_trace_id()


def _safe_internal_meeting_id(value: Any) -> Optional[str]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value < 0 or value.bit_length() > 67:
            return None
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,20}", value):
        return None
    return hashlib.sha256(str(int(value)).encode("ascii")).hexdigest()[:16]

def _safe_fields(fields: Optional[dict]) -> dict:
    safe = {}
    if not isinstance(fields, dict):
        return safe
    for key, value in fields.items():
        if key not in _SAFE_FIELDS:
            continue
        if key == "method" and isinstance(value, str) and value in {
            "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"
        }:
            safe[key] = value
        elif key == "route" and isinstance(value, str) and _is_route_template(value) and "{" in value:
            safe[key] = value
        elif key == "minted" and isinstance(value, bool):
            safe[key] = value
        elif key in {"downstream_status", "status", "count", "duration_ms", "bytes"} and (
            isinstance(value, int) and not isinstance(value, bool) and value >= 0
        ):
            safe[key] = value
        elif key == "required" and isinstance(value, (list, tuple)) and all(
            isinstance(item, str) and item in _SCOPE_NAMES for item in value
        ):
            safe[key] = sorted(set(value))
        elif key == "reason" and isinstance(value, str) and value in _SAFE_REASONS:
            safe[key] = value
    return safe


class SafeProcessLogFilter(logging.Filter):
    """Reduce arbitrary Python log records to bounded, non-sensitive metadata."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno < logging.INFO:
            return False
        record.name = "python"
        record.msg = "log_record"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        record.pathname = ""
        record.filename = ""
        record.module = ""
        record.funcName = ""
        record.lineno = 0
        for key in tuple(record.__dict__):
            if key not in _LOG_RECORD_KEYS and key not in {
                "status", "count", "duration_ms", "bytes", "trace_id"
            }:
                del record.__dict__[key]
        for key in ("status", "count", "duration_ms", "bytes"):
            value = getattr(record, key, None)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                record.__dict__.pop(key, None)
        if not isinstance(getattr(record, "trace_id", None), str) or not _TRACE_ID_RE.fullmatch(
            record.trace_id
        ):
            record.__dict__.pop("trace_id", None)
        return True


class SafeProcessLogFormatter(logging.Formatter):
    """Emit fixed JSON fields only; arbitrary message text is never serialized."""

    def format(self, record: logging.LogRecord) -> str:
        envelope = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower() if record.levelname.lower() in _LEVELS else "info",
            "service": "gateway",
            "event": "python_log",
            "logger": "python",
        }
        trace_id = getattr(record, "trace_id", None)
        if isinstance(trace_id, str) and _TRACE_ID_RE.fullmatch(trace_id):
            envelope["trace_id"] = trace_id
        fields = {
            key: getattr(record, key)
            for key in ("status", "count", "duration_ms", "bytes")
            if isinstance(getattr(record, key, None), int)
            and not isinstance(getattr(record, key, None), bool)
            and getattr(record, key) >= 0
        }
        if fields:
            envelope["fields"] = fields
        return json.dumps(envelope, separators=(",", ":"))


_LOG_RECORD_KEYS = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename", "module",
    "exc_info", "exc_text", "stack_info", "lineno", "funcName", "created", "msecs",
    "relativeCreated", "thread", "threadName", "processName", "process",
}


def safe_logging_config() -> dict:
    """Uvicorn dictConfig with the sanitizer applied at every configured handler."""
    filter_path = "gateway.obs.SafeProcessLogFilter"
    formatter_path = "gateway.obs.SafeProcessLogFormatter"
    handler = {
        "class": "logging.StreamHandler",
        "formatter": "safe",
        "filters": ["privacy"],
        "stream": "ext://sys.stderr",
    }
    logger = {"handlers": ["default"], "level": "INFO", "propagate": False}
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "filters": {"privacy": {"()": filter_path}},
        "formatters": {"safe": {"()": formatter_path}},
        "handlers": {"default": handler},
        "root": {"handlers": ["default"], "level": "INFO"},
        "loggers": {
            "uvicorn": dict(logger),
            "uvicorn.error": dict(logger),
            "uvicorn.access": dict(logger),
        },
    }

LOG_CONFIG = safe_logging_config()


def install_process_logging_hooks() -> None:
    logging.captureWarnings(True)
    logger = logging.getLogger("gateway.process")

    def handle_exception(exc_type, exc_value, traceback) -> None:
        logger.critical("unhandled process exception", exc_info=(exc_type, exc_value, traceback))

    def handle_thread_exception(args) -> None:
        logger.critical(
            "unhandled thread exception",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    def handle_unraisable(args) -> None:
        logger.critical(
            "unraisable process exception",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = handle_exception
    threading.excepthook = handle_thread_exception
    sys.unraisablehook = handle_unraisable


def configure_process_logging() -> None:
    logging.config.dictConfig(LOG_CONFIG)
    for name in ("push_response", "charset_normalizer", "aiohttp.access", "urllib3", "sqlalchemy.engine.Engine"):
        logging.getLogger(name).disabled = True
    install_process_logging_hooks()
    logging.getLogger("uvicorn.access").disabled = True

TRACE_HEADER = "x-trace-id"

# Process-wide context: the current request's trace_id.
_trace_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("trace_id", default=None)
_user_id: contextvars.ContextVar[Optional[Any]] = contextvars.ContextVar("user_id", default=None)

# Optional test sink: when a list is installed, every emitted envelope is also appended to it
# (an eval captures lines deterministically without relying on stdout capture across threads).
_sink: Optional[list] = None


def capture(sink: Optional[list]) -> None:
    """Install (or clear, with ``None``) a list that receives every emitted envelope."""
    global _sink
    _sink = sink


def new_trace_id() -> str:
    """Mint a fresh trace id (hex, no dashes)."""
    return uuid.uuid4().hex


def get_trace_id() -> Optional[str]:
    return _trace_id.get()

def set_trace_id(trace_id: str) -> contextvars.Token:
    """Bind a trace ID for the current context; emitted IDs are validated at the sink."""
    return _trace_id.set(trace_id)


def set_user_id(user_id: Any) -> contextvars.Token:
    """Bind a user ID for the current context without exposing it in log records."""
    return _user_id.set(user_id)





def make_log_event(service: str) -> Callable[..., dict]:
    """Build a ``log_event`` bound to ``service`` (the ``logevent.v1`` ``service`` field)."""

    def log_event(
        event: str,
        *,
        audience: str,
        level: str = "info",
        span: Optional[str] = None,
        user_id: Any = None,
        meeting_id: Any = None,
        fields: Optional[dict] = None,
        stream=None,
    ) -> dict:
        """Emit one sanitized ``logevent.v1`` JSON line to stdout and return it."""
        safe_level = level.lower() if isinstance(level, str) else "info"
        if _LEVELS.get(safe_level, _LEVELS["info"]) < _LEVELS["info"]:
            return {}
        safe_event = event if isinstance(event, str) and event in _SAFE_EVENTS else "event"
        envelope: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": safe_level if safe_level in _LEVELS else "info",
            "service": service if isinstance(service, str) and service in _SAFE_SERVICES else "service",
            "trace_id": _safe_trace_id(_trace_id.get()),
            "audience": audience if audience in {"user", "system"} else "system",
            "event": safe_event,
        }
        if span is not None and isinstance(span, str) and span in _SAFE_SPANS:
            envelope["span"] = span
        safe_meeting_id = _safe_internal_meeting_id(meeting_id)
        if safe_meeting_id is not None:
            envelope["meeting_id"] = safe_meeting_id
        safe = _safe_fields(fields)
        if safe:
            envelope["fields"] = safe
        print(json.dumps(envelope, separators=(",", ":")), file=stream or sys.stdout, flush=True)
        if _sink is not None:
            _sink.append(envelope)
        return envelope

    return log_event


def make_trace_middleware(log_event: Callable[..., dict]) -> type:
    """Build a TraceMiddleware class that logs via ``log_event``."""

    class TraceMiddleware(BaseHTTPMiddleware):
        """Read ``X-Trace-Id`` (mint at the edge if absent), bind it for the request, echo it
        on the response. Downstream hops forward the same header so the trace is continuous."""

        async def dispatch(self, request, call_next):
            incoming = request.headers.get(TRACE_HEADER)
            trace_id = incoming if isinstance(incoming, str) and _TRACE_ID_RE.fullmatch(incoming) else new_trace_id()
            token = _trace_id.set(trace_id)
            try:
                request.state.trace_id = trace_id
                log_event(
                    "request_received",
                    audience="system",
                    level="info",
                    span="edge",
                    fields={
                        "method": request.method,
                        "minted": incoming is None or trace_id != incoming,
                    },
                )
                response = await call_next(request)
                response.headers[TRACE_HEADER] = trace_id
                return response
            finally:
                _trace_id.reset(token)

    return TraceMiddleware


# ---- This lane's binding: the gateway edge (service = "gateway") ----
SERVICE = "gateway"
log_event = make_log_event(SERVICE)
TraceMiddleware = make_trace_middleware(log_event)
