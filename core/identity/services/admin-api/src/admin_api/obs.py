"""Process-boundary privacy logging for admin-api entrypoints."""
from __future__ import annotations

import json
import logging
import logging.config
import sys
import threading
from datetime import datetime, timezone

_LOG_RECORD_KEYS = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename", "module",
    "exc_info", "exc_text", "stack_info", "lineno", "funcName", "created", "msecs",
    "relativeCreated", "thread", "threadName", "processName", "process",
}


class PrivacyFilter(logging.Filter):
    """Discard unstructured messages, exception payloads, and caller-supplied fields."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = "admin_api"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        for key in tuple(record.__dict__):
            if key not in _LOG_RECORD_KEYS:
                del record.__dict__[key]
        record.event = "log_event"
        return True


class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": "admin_api",
            "event": record.event,
        }, separators=(",", ":"))


LOG_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"privacy": {"()": "admin_api.obs.PrivacyFilter"}},
    "formatters": {"json": {"()": "admin_api.obs.JSONFormatter"}},
    "handlers": {
        "default": {
            "class": "logging.StreamHandler",
            "formatter": "json",
            "filters": ["privacy"],
            "stream": "ext://sys.stderr",
        },
    },
    "root": {"handlers": ["default"], "level": "INFO"},
    "loggers": {
        "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.access": {"handlers": ["default"], "level": "INFO", "propagate": False},
    },
}


def install_process_logging_hooks() -> None:
    logging.captureWarnings(True)
    logger = logging.getLogger("admin_api.process")

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


def configure_privacy_logging() -> None:
    logging.config.dictConfig(LOG_CONFIG)
    for name in ("push_response", "charset_normalizer", "aiohttp.access", "urllib3", "sqlalchemy.engine.Engine"):
        logging.getLogger(name).disabled = True
    install_process_logging_hooks()
    logging.getLogger("uvicorn.access").disabled = True
