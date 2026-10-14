"""``python -m gateway`` — the production run entrypoint (P4 compose CMD).

Serves the gateway edge built by ``adapters.build_production_app()`` (real httpx + redis adapters
from env: ADMIN_API_URL / MEETING_API_URL / REDIS_URL). Equivalent to
``uvicorn gateway.adapters:app`` — kept as a module so the image CMD can be a plain
``python -m gateway`` and HOST/PORT are read from env.
"""
from __future__ import annotations

import os

from .obs import safe_logging_config

LOG_CONFIG = safe_logging_config()


def main() -> None:
    import logging.config

    logging.config.dictConfig(LOG_CONFIG)
    from .obs import install_process_logging_hooks

    install_process_logging_hooks()
    import uvicorn

    uvicorn.run(
        "gateway.adapters:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
        log_config=LOG_CONFIG,
        access_log=False,
    )


if __name__ == "__main__":
    main()
